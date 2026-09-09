import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type WorkStateCategory
} from '../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemCreateMetadataInput,
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';
import { jiraProjectKeysFromJql } from './jira-scope.js';

const jiraIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    fields: z
      .object({
        summary: z.string(),
        description: z.unknown().nullable().optional(),
        updated: z.string(),
        status: z
          .object({
            id: z.string().min(1),
            name: z.string(),
            statusCategory: z.object({ key: z.string() }).passthrough()
          })
          .passthrough(),
        priority: z.object({ name: z.string() }).passthrough().nullable(),
        assignee: z
          .object({
            accountId: z.string().min(1).optional(),
            displayName: z.string()
          })
          .passthrough()
          .nullable(),
        project: z.object({ key: z.string(), name: z.string() }).passthrough(),
        labels: z.array(z.string()),
        comment: z
          .object({
            comments: z.array(
              z
                .object({
                  body: z.unknown(),
                  created: z.string(),
                  author: z.object({ displayName: z.string() }).passthrough()
                })
                .passthrough()
            )
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

const jiraSearchPageSchema = z
  .object({
    issues: z.array(jiraIssueSchema),
    nextPageToken: z.string().nullable().optional()
  })
  .passthrough();

const jiraWorklogPageSchema = z
  .object({
    worklogs: z.array(
      z
        .object({
          comment: z.unknown().nullable().optional(),
          author: z
            .object({ accountId: z.string().optional() })
            .passthrough()
            .nullable()
            .optional()
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraMyselfSchema = z
  .object({ accountId: z.string().min(1) })
  .passthrough();

const jiraJqlMatchSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            matchedIssues: z.array(z.number().int().positive()),
            errors: z.array(z.string())
          })
          .passthrough()
      )
      .length(1)
  })
  .passthrough();

const jiraTransitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string().min(1),
          to: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              statusCategory: z.object({ key: z.string() }).passthrough()
            })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraCreatedIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    self: z.string().optional()
  })
  .passthrough();

const jiraCreateIssueTypesSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    issueTypes: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          subtask: z.boolean().default(false)
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraCreateFieldsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    fields: z.array(
      z
        .object({
          fieldId: z.string().min(1),
          allowedValues: z.array(z.unknown()).optional()
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraAssignableUserSchema = z
  .object({
    accountId: z.string().min(1),
    displayName: z.string().min(1),
    active: z.boolean().optional()
  })
  .passthrough();
const jiraAssignableUsersSchema = z.array(jiraAssignableUserSchema);

const jiraLabelsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    isLast: z.boolean(),
    values: z.array(z.string().min(1))
  })
  .passthrough();

const jiraNamedIdSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .passthrough();
const JIRA_CREATE_METADATA_PAGE_SIZE = 200;
const JIRA_LABEL_PAGE_SIZE = 1000;

function nextJiraPageStart(
  page: {
    startAt: number;
    maxResults: number;
    total: number;
    isLast?: boolean;
  },
  requestedStart: number,
  itemCount: number
): number | null {
  if (page.startAt !== requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  if (itemCount === 0 || page.isLast === true) return null;
  const nextStart = page.startAt + page.maxResults;
  if (nextStart >= page.total) return null;
  if (nextStart <= requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  return nextStart;
}

function jiraDescription(value: string) {
  return {
    type: 'doc',
    version: 1,
    content: value.split(/\r?\n/u).map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  };
}

function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = typeof record.text === 'string' ? record.text : '';
  const children = Array.isArray(record.content)
    ? record.content.map(adfText).filter(Boolean)
    : [];
  const joined = [own, ...children]
    .filter(Boolean)
    .join(record.type === 'paragraph' || record.type === 'heading' ? '' : '\n');
  return record.type === 'paragraph' || record.type === 'heading'
    ? `${joined}\n`
    : joined;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

function asAdfNode(value: unknown): AdfNode | null {
  return value && typeof value === 'object' ? (value as AdfNode) : null;
}

function applyMarks(text: string, marks: AdfNode['marks']): string {
  if (!text) return text;
  let out = text;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'strong':
        out = `**${out}**`;
        break;
      case 'em':
        out = `*${out}*`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'link': {
        const href = mark.attrs?.href;
        if (typeof href === 'string') out = `[${out}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function adfInline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += applyMarks(node.text ?? '', node.marks);
        break;
      case 'hardBreak':
        out += '\n';
        break;
      case 'inlineCard': {
        const url = node.attrs?.url;
        if (typeof url === 'string') out += url;
        break;
      }
      case 'mention': {
        const label = node.attrs?.text;
        if (typeof label === 'string') out += label;
        break;
      }
      case 'emoji': {
        const short = node.attrs?.shortName ?? node.attrs?.text;
        if (typeof short === 'string') out += short;
        break;
      }
      default:
        if (node.content) out += adfInline(node.content);
        break;
    }
  }
  return out;
}

function adfBlocks(nodes: AdfNode[] | undefined, depth = 0): string {
  if (!nodes) return '';
  const parts: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        parts.push(adfInline(node.content));
        break;
      case 'heading': {
        const level = Math.min(
          6,
          Math.max(1, Number(node.attrs?.level) || 1)
        );
        parts.push(`${'#'.repeat(level)} ${adfInline(node.content)}`);
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList';
        const items = node.content ?? [];
        const lines = items.map((item, index) => {
          const marker = ordered ? `${index + 1}.` : '-';
          const inner = adfBlocks(item.content, depth + 1).trimEnd();
          const indented = inner
            .split('\n')
            .map((line, i) => (i === 0 ? line : `  ${line}`))
            .join('\n');
          return `${'  '.repeat(depth)}${marker} ${indented}`;
        });
        parts.push(lines.join('\n'));
        break;
      }
      case 'codeBlock': {
        const language =
          typeof node.attrs?.language === 'string' ? node.attrs.language : '';
        const code = (node.content ?? [])
          .map(child => child.text ?? '')
          .join('');
        parts.push(`\`\`\`${language}\n${code}\n\`\`\``);
        break;
      }
      case 'blockquote':
        parts.push(
          adfBlocks(node.content, depth)
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n')
        );
        break;
      case 'panel': {
        const panelType =
          typeof node.attrs?.panelType === 'string'
            ? node.attrs.panelType
            : 'info';
        const body = adfBlocks(node.content, depth);
        parts.push(
          `> [!${panelType.toUpperCase()}]\n` +
            body
              .split('\n')
              .map(line => `> ${line}`)
              .join('\n')
        );
        break;
      }
      case 'rule':
        parts.push('---');
        break;
      case 'table': {
        const rows = node.content ?? [];
        const rendered: string[] = [];
        rows.forEach((row, rowIndex) => {
          const cells = (row.content ?? []).map(cell =>
            adfBlocks(cell.content, depth).replace(/\n+/gu, ' ').trim()
          );
          rendered.push(`| ${cells.join(' | ')} |`);
          if (rowIndex === 0) {
            rendered.push(`| ${cells.map(() => '---').join(' | ')} |`);
          }
        });
        parts.push(rendered.join('\n'));
        break;
      }
      case 'mediaSingle':
      case 'mediaGroup': {
        const media = (node.content ?? []).find(m => m.type === 'media');
        const alt =
          typeof media?.attrs?.alt === 'string' ? media.attrs.alt : 'attachment';
        const url = media?.attrs?.url;
        if (typeof url === 'string') {
          parts.push(`![${alt}](${url})`);
        } else {
          parts.push(`_[${alt}]_`);
        }
        break;
      }
      default:
        if (node.content) parts.push(adfBlocks(node.content, depth));
        break;
    }
  }
  return parts.filter(part => part.length > 0).join('\n\n');
}

function adfToMarkdown(value: unknown): string {
  const root = asAdfNode(value);
  if (!root) return typeof value === 'string' ? value : '';
  return adfBlocks(root.content ?? []).trim();
}

function stateCategory(key: string): WorkStateCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

const WORKLOG_DONE_MARKER = 'DONE';
const WORKLOG_MARKER_RE = /\[([A-Za-z0-9 &/_-]+)\]/g;

function worklogMarkers(text: string): string[] {
  const markers: string[] = [];
  for (const match of text.matchAll(WORKLOG_MARKER_RE)) {
    const value = match[1]?.trim().toUpperCase();
    if (value) markers.push(value);
  }
  return markers;
}

interface DerivedWorklogState {
  stateCategory: WorkStateCategory;
  status: string;
  markers: string[];
}

interface HierarchyInfo {
  storyKey: string | null;
  storySummary: string | null;
  epicKey: string | null;
  epicSummary: string | null;
  epicExpectedStart: string | null;
  epicExpectedDone: string | null;
}

const JIRA_EXTRA_FIELDS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'customfield_10033', label: 'Platform Engineer' },
  { id: 'customfield_11397', label: 'PIC Lead Engineer' },
  { id: 'customfield_11398', label: 'PIC Lead QA' },
  { id: 'customfield_11431', label: 'Story Point PE' },
  { id: 'customfield_10024', label: 'Story Point' },
  { id: 'customfield_10069', label: 'Story Point' },
  { id: 'customfield_10016', label: 'Story point estimate' }
];

function jiraFieldToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.map(jiraFieldToText).filter((v): v is string => !!v);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate =
      record.displayName ?? record.value ?? record.name ?? record.timeSpent;
    return typeof candidate === 'string'
      ? candidate.trim() || null
      : typeof candidate === 'number'
        ? String(candidate)
        : null;
  }
  return null;
}

function extraFieldsFromIssue(
  issue: z.infer<typeof jiraIssueSchema>
): Array<{ label: string; value: string }> {
  const fields = issue.fields as unknown as Record<string, unknown>;
  const seenLabels = new Set<string>();
  const out: Array<{ label: string; value: string }> = [];
  for (const { id, label } of JIRA_EXTRA_FIELDS) {
    if (seenLabels.has(label)) continue;
    const text = jiraFieldToText(fields[id]);
    if (text) {
      out.push({ label, value: text });
      seenLabels.add(label);
    }
  }
  const timeSpent = jiraFieldToText(fields.timespent);
  if (timeSpent && /^\d+$/u.test(timeSpent)) {
    const minutes = Math.round(Number(timeSpent) / 60);
    out.push({ label: 'Time logged', value: `${minutes}m` });
  }
  return out;
}

function deriveWorklogState(
  worklogs: Array<{ comment: unknown; authorAccountId: string | null }>,
  myAccountId: string | null
): DerivedWorklogState {
  const markerCounts = new Map<string, number>();
  let doneByMe = false;
  for (const log of worklogs) {
    const text = adfText(log.comment);
    for (const marker of worklogMarkers(text)) {
      markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
      if (
        marker === WORKLOG_DONE_MARKER &&
        (myAccountId === null || log.authorAccountId === myAccountId)
      ) {
        doneByMe = true;
      }
    }
  }
  const markers = [...markerCounts.keys()].sort();
  if (doneByMe) {
    return { stateCategory: 'done', status: 'Done', markers };
  }
  if (worklogs.length > 0) {
    return { stateCategory: 'in_progress', status: 'In Progress', markers };
  }
  return { stateCategory: 'todo', status: 'Todo', markers };
}

function toItem(
  baseUrl: string,
  issue: z.infer<typeof jiraIssueSchema>,
  derived?: DerivedWorklogState,
  hierarchy?: HierarchyInfo
): ExternalWorkItemDetail {
  return {
    source: 'jira',
    locator: issue.key,
    key: issue.key,
    title: issue.fields.summary,
    description: adfToMarkdown(issue.fields.description),
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    status: derived ? derived.status : issue.fields.status.name,
    stateCategory: derived
      ? derived.stateCategory
      : stateCategory(issue.fields.status.statusCategory.key),
    priority: issue.fields.priority?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    project: issue.fields.project.name,
    labels: derived
      ? [...derived.markers, ...issue.fields.labels]
      : issue.fields.labels,
    updatedAt: issue.fields.updated,
    extraFields: extraFieldsFromIssue(issue),
    storyKey: hierarchy?.storyKey ?? null,
    storySummary: hierarchy?.storySummary ?? null,
    epicKey: hierarchy?.epicKey ?? null,
    epicSummary: hierarchy?.epicSummary ?? null,
    epicExpectedStart: hierarchy?.epicExpectedStart ?? null,
    epicExpectedDone: hierarchy?.epicExpectedDone ?? null,
    comments: (issue.fields.comment?.comments ?? []).map(comment => ({
      author: comment.author.displayName,
      body: adfToMarkdown(comment.body),
      createdAt: comment.created
    }))
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const hasExplicitPort = /^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/iu.test(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      !(
        parsed.hostname === 'atlassian.net' ||
        parsed.hostname.endsWith('.atlassian.net')
      ) ||
      parsed.username ||
      parsed.password ||
      hasExplicitPort ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

async function jiraRequest(
  options: { baseUrl: string; email: string; apiToken: string },
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`,
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' })
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Jira');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}`);
  return payload;
}

export function createJiraAdapter(options: {
  enabled: boolean;
  baseUrl: string;
  email: string;
  apiToken: string | undefined;
  jql: string;
}): WorkSourceAdapter {
  const rawBaseUrl = options.baseUrl.trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const email = options.email.trim();
  const apiToken = options.apiToken?.trim() ?? '';
  const hasCredentials = Boolean(baseUrl && email && apiToken);
  const configured = options.enabled && hasCredentials;
  const auth = {
    baseUrl,
    email,
    apiToken
  };

  let myAccountIdCache: string | null | undefined;
  async function myAccountId(): Promise<string | null> {
    if (myAccountIdCache !== undefined) return myAccountIdCache;
    try {
      const payload = await jiraRequest(auth, '/rest/api/3/myself');
      myAccountIdCache = jiraMyselfSchema.parse(payload).accountId;
    } catch {
      myAccountIdCache = null;
    }
    return myAccountIdCache;
  }

  async function loadWorklogState(
    locator: string,
    account: string | null
  ): Promise<DerivedWorklogState> {
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}/worklog?maxResults=100`
    );
    const page = jiraWorklogPageSchema.parse(payload);
    return deriveWorklogState(
      page.worklogs.map(w => ({
        comment: w.comment ?? null,
        authorAccountId: w.author?.accountId ?? null
      })),
      account
    );
  }

  async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        for (;;) {
          const index = cursor++;
          if (index >= items.length) return;
          results[index] = await fn(items[index]!);
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  async function loadStoryIssue(
    key: string
  ): Promise<{ summary: string | null; epicKey: string | null } | null> {
    try {
      const payload = await jiraRequest(
        auth,
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,parent`
      );
      const node = payload as {
        fields?: {
          summary?: string;
          parent?: { key?: string };
        };
      };
      return {
        summary: node.fields?.summary ?? null,
        epicKey: node.fields?.parent?.key ?? null
      };
    } catch {
      return null;
    }
  }

  async function loadEpicIssue(
    key: string
  ): Promise<{
    summary: string | null;
    expectedStart: string | null;
    expectedDone: string | null;
  } | null> {
    try {
      const payload = await jiraRequest(
        auth,
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,customfield_10360,customfield_10361`
      );
      const node = payload as {
        fields?: {
          summary?: string;
          customfield_10360?: string | null;
          customfield_10361?: string | null;
        };
      };
      return {
        summary: node.fields?.summary ?? null,
        expectedStart: node.fields?.customfield_10360 ?? null,
        expectedDone: node.fields?.customfield_10361 ?? null
      };
    } catch {
      return null;
    }
  }

  async function loadHierarchyMap(
    issues: z.infer<typeof jiraIssueSchema>[]
  ): Promise<Map<string, HierarchyInfo>> {
    const result = new Map<string, HierarchyInfo>();
    const storyKeys = new Set<string>();
    for (const issue of issues) {
      const parentKey = (issue.fields as { parent?: { key?: string } }).parent
        ?.key;
      if (parentKey) storyKeys.add(parentKey);
    }
    const uniqueStoryKeys = [...storyKeys];
    const storyEntries = await mapWithConcurrency(
      uniqueStoryKeys,
      6,
      async key => [key, await loadStoryIssue(key)] as const
    );
    const stories = new Map(storyEntries);

    const epicKeys = new Set<string>();
    for (const [, story] of stories) {
      if (story?.epicKey) epicKeys.add(story.epicKey);
    }
    const epicEntries = await mapWithConcurrency(
      [...epicKeys],
      6,
      async key => [key, await loadEpicIssue(key)] as const
    );
    const epics = new Map(epicEntries);

    for (const issue of issues) {
      const storyKey = (issue.fields as { parent?: { key?: string } }).parent
        ?.key ?? null;
      const story = storyKey ? stories.get(storyKey) : null;
      const epicKey = story?.epicKey ?? null;
      const epic = epicKey ? epics.get(epicKey) : null;
      result.set(issue.key, {
        storyKey,
        storySummary: story?.summary ?? null,
        epicKey,
        epicSummary: epic?.summary ?? null,
        epicExpectedStart: epic?.expectedStart ?? null,
        epicExpectedDone: epic?.expectedDone ?? null
      });
    }
    return result;
  }

  async function loadIssue(
    locator: string,
    flags: { comments: boolean; verifyScope: boolean }
  ): Promise<z.infer<typeof jiraIssueSchema>> {
    const fields = [
      'summary',
      'description',
      'updated',
      'status',
      'priority',
      'assignee',
      'project',
      'labels',
      'parent',
      'timespent',
      'customfield_10033',
      'customfield_11397',
      'customfield_11398',
      'customfield_11431',
      'customfield_10024',
      'customfield_10069',
      'customfield_10016',
      ...(flags.comments ? ['comment'] : [])
    ].join(',');
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}?fields=${encodeURIComponent(fields)}`
    );
    const issue = jiraIssueSchema.parse(payload);
    if (issue.key !== locator) {
      throw new Error(`Jira returned the wrong issue for ${locator}`);
    }
    if (!flags.verifyScope) return issue;
    const issueId = Number(issue.id);
    if (!Number.isSafeInteger(issueId)) {
      throw new Error(`Jira returned an invalid issue id for ${locator}`);
    }
    const matchPayload = await jiraRequest(auth, '/rest/api/3/jql/match', {
      method: 'POST',
      body: JSON.stringify({
        issueIds: [issueId],
        jqls: [options.jql.trim()]
      })
    });
    const match = jiraJqlMatchSchema.parse(matchPayload).matches[0];
    if (!match || match.errors.length > 0) {
      throw new Error('Jira could not verify the configured scope');
    }
    if (!match.matchedIssues.includes(issueId)) {
      throw new Error(`Jira issue ${locator} is outside the configured scope`);
    }
    return issue;
  }

  async function transitionOptions(locator: string): Promise<{
    issue: z.infer<typeof jiraIssueSchema>;
    options: Array<ExternalWorkStatusOption & { transitionId: string | null }>;
  }> {
    const issue = await loadIssue(locator, {
      comments: false,
      verifyScope: true
    });
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`
    );
    const transitions = jiraTransitionsSchema.parse(payload).transitions;
    const available = new Map<
      string,
      ExternalWorkStatusOption & { transitionId: string | null }
    >();
    available.set(issue.fields.status.id, {
      id: issue.fields.status.id,
      name: issue.fields.status.name,
      stateCategory: stateCategory(issue.fields.status.statusCategory.key),
      current: true,
      transitionId: null
    });
    for (const transition of transitions) {
      if (available.has(transition.to.id)) continue;
      available.set(transition.to.id, {
        id: transition.to.id,
        name: transition.to.name,
        stateCategory: stateCategory(transition.to.statusCategory.key),
        current: transition.to.id === issue.fields.status.id,
        transitionId: transition.id
      });
    }
    return { issue, options: [...available.values()] };
  }

  function assertProjectKey(destinationId: string): string {
    const projectKey = destinationId.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/u.test(projectKey)) {
      throw new Error('Enter a valid Jira project key');
    }
    const configuredProjectKeys = jiraProjectKeysFromJql(options.jql);
    if (
      configuredProjectKeys.length > 0 &&
      !configuredProjectKeys.includes(projectKey)
    ) {
      throw new Error(
        `Jira project ${projectKey} is outside the configured JQL scope`
      );
    }
    return projectKey;
  }

  async function createMetadata(input: ExternalWorkItemCreateMetadataInput) {
    const projectKey = assertProjectKey(input.destinationId);
    const issueTypesById = new Map<
      string,
      z.infer<typeof jiraCreateIssueTypesSchema>['issueTypes'][number]
    >();
    let issueTypesStart = 0;
    for (;;) {
      const issueTypesPayload = await jiraRequest(
        auth,
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?startAt=${issueTypesStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
      );
      const page = jiraCreateIssueTypesSchema.parse(issueTypesPayload);
      for (const issueType of page.issueTypes) {
        issueTypesById.set(issueType.id, issueType);
      }
      const nextStart = nextJiraPageStart(
        page,
        issueTypesStart,
        page.issueTypes.length
      );
      if (nextStart === null) break;
      issueTypesStart = nextStart;
    }
    const issueTypes = [...issueTypesById.values()].filter(
      issueType => !issueType.subtask
    );
    const requestedIssueType = input.issueType?.trim() ?? '';
    const selectedIssueType =
      issueTypes.find(issueType => issueType.id === requestedIssueType) ??
      (requestedIssueType
        ? issueTypes.find(
            issueType =>
              issueType.name.toLowerCase() ===
              requestedIssueType.toLowerCase()
          )
        : undefined) ??
      issueTypes.find(issueType => issueType.name.toLowerCase() === 'task') ??
      issueTypes[0] ??
      null;
    if (!selectedIssueType) {
      throw new Error(`Jira project ${projectKey} has no available issue types`);
    }
    const fieldsById = new Map<
      string,
      z.infer<typeof jiraCreateFieldsSchema>['fields'][number]
    >();
    let fieldsStart = 0;
    for (;;) {
      const fieldsPayload = await jiraRequest(
        auth,
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(selectedIssueType.id)}?startAt=${fieldsStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
      );
      const page = jiraCreateFieldsSchema.parse(fieldsPayload);
      for (const field of page.fields) fieldsById.set(field.fieldId, field);
      const nextStart = nextJiraPageStart(
        page,
        fieldsStart,
        page.fields.length
      );
      if (nextStart === null) break;
      fieldsStart = nextStart;
    }
    const fields = [...fieldsById.values()];
    const byId = new Map(fields.map(field => [field.fieldId, field]));
    const assigneeField = byId.get('assignee');
    const priorityField = byId.get('priority');
    const assigneeAllowed = (assigneeField?.allowedValues ?? [])
      .map(value => jiraAssignableUserSchema.safeParse(value))
      .filter(result => result.success)
      .map(result => result.data);
    const priorityAllowed = (priorityField?.allowedValues ?? [])
      .map(value => jiraNamedIdSchema.safeParse(value))
      .filter(result => result.success)
      .map(result => result.data);
    const [fallbackAssignees, labels] = await Promise.all([
      assigneeField
        ? jiraRequest(
            auth,
            `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&startAt=0&maxResults=1000`
          )
            .then(payload => jiraAssignableUsersSchema.parse(payload))
            .catch(() => [])
        : Promise.resolve([]),
      byId.has('labels')
        ? (async () => {
            const labels = new Set<string>();
            let labelsStart = 0;
            for (;;) {
              const payload = await jiraRequest(
                auth,
                `/rest/api/3/label?startAt=${labelsStart}&maxResults=${JIRA_LABEL_PAGE_SIZE}`
              );
              const page = jiraLabelsSchema.parse(payload);
              for (const label of page.values) labels.add(label);
              const nextStart = nextJiraPageStart(
                page,
                labelsStart,
                page.values.length
              );
              if (nextStart === null) break;
              labelsStart = nextStart;
            }
            return [...labels];
          })().catch(() => [])
        : Promise.resolve([])
    ]);
    const assignees = [
      ...new Map(
        [...assigneeAllowed, ...fallbackAssignees].map(user => [
          user.accountId,
          user
        ])
      ).values()
    ];
    return {
      statusOptions: [],
      assigneeOptions: assignees
        .filter(user => user.active !== false)
        .map(user => ({ id: user.accountId, label: user.displayName })),
      priorityOptions: priorityAllowed.map(priority => ({
        id: priority.id,
        label: priority.name
      })),
      labelOptions: labels.map(label => ({ id: label, label })),
      milestoneOptions: [],
      issueTypeOptions: issueTypes.map(issueType => ({
        id: issueType.id,
        label: issueType.name
      })),
      defaultStatusId: null,
      defaultIssueTypeId: selectedIssueType.id,
      supportsDueDate: byId.has('duedate')
    };
  }

  return {
    source: 'jira',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Jira for this BB project in Manage.'
        : rawBaseUrl && !baseUrl
          ? 'Jira Cloud URL must be an HTTPS atlassian.net origin.'
          : hasCredentials
            ? null
            : 'Set the Jira URL, email, and API token for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Jira is not configured');
      const issues: z.infer<typeof jiraIssueSchema>[] = [];
      const seenPageTokens = new Set<string>();
      let nextPageToken: string | undefined;
      for (;;) {
        const payload = await jiraRequest(auth, '/rest/api/3/search/jql', {
          method: 'POST',
          body: JSON.stringify({
            jql: options.jql.trim(),
            maxResults: 100,
            fields: [
              'summary',
              'description',
              'updated',
              'status',
              'priority',
              'assignee',
              'project',
              'labels',
              'parent',
              'timespent',
              'customfield_10033',
              'customfield_11397',
              'customfield_11398',
              'customfield_11431',
              'customfield_10024',
              'customfield_10069',
              'customfield_10016'
            ],
            ...(nextPageToken ? { nextPageToken } : {})
          })
        });
        const page = jiraSearchPageSchema.parse(payload);
        issues.push(...page.issues);
        const token = page.nextPageToken?.trim();
        if (!token) break;
        if (seenPageTokens.has(token)) {
          throw new Error('Jira returned an invalid pagination token');
        }
        seenPageTokens.add(token);
        nextPageToken = token;
      }
      const account = await myAccountId();
      const derivedStates = await mapWithConcurrency(
        issues,
        8,
        async issue => {
          try {
            return await loadWorklogState(issue.key, account);
          } catch {
            return deriveWorklogState([], account);
          }
        }
      );
      const hierarchy = await loadHierarchyMap(issues);
      return issues.map((issue, index) =>
        withoutComments(
          toItem(baseUrl, issue, derivedStates[index], hierarchy.get(issue.key))
        )
      );
    },
    async get(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const issue = await loadIssue(locator, {
        comments: true,
        verifyScope: true
      });
      const account = await myAccountId();
      let derived: DerivedWorklogState | undefined;
      try {
        derived = await loadWorklogState(locator, account);
      } catch {
        derived = undefined;
      }
      let hierarchy: HierarchyInfo | undefined;
      try {
        hierarchy = (await loadHierarchyMap([issue])).get(issue.key);
      } catch {
        hierarchy = undefined;
      }
      return toItem(baseUrl, issue, derived, hierarchy);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const account = await myAccountId();
      const derived = await loadWorklogState(locator, account);
      return [
        {
          id: derived.stateCategory,
          name: derived.status,
          stateCategory: derived.stateCategory,
          current: true
        }
      ];
    },
    async createMetadata() {
      throw new Error('Taskboard is read-only for Jira; issue creation is disabled.');
    },
    async create(_input: ExternalWorkItemCreateInput) {
      throw new Error('Taskboard is read-only for Jira; issue creation is disabled.');
    },
    async updateStatus(_locator, _statusId) {
      throw new Error('Taskboard is read-only for Jira; status changes are disabled.');
    }
  };
}
