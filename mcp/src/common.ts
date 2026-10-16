/**
 * Shared helpers for Fairquery stdio MCP servers.
 * APIFY_TOKEN is read from the environment only for tool calls and is never logged or returned.
 */
export const APIFY_BASE = 'https://api.apify.com/v2';

export type ToolResult = {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [k: string]: unknown;
};

export function ok(structured: Record<string, unknown>): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

export function fail(error: string, message: string): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }], isError: true };
}

export function getToken(): string | null {
    const t = process.env.APIFY_TOKEN?.trim();
    return t ? t : null;
}

export const TOKEN_MISSING = () =>
    fail(
        'APIFY_TOKEN_MISSING',
        'Set the APIFY_TOKEN environment variable to your Apify API token before calling this tool. Initialize, tools/list and the free helper tool work without a token.',
    );

export function compact(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) out[k] = v;
    return out;
}

/** Runs the Actor synchronously and returns its dataset items. */
export async function runActor(actorId: string, input: Record<string, unknown>, token: string, waitSecs = 280): Promise<unknown[]> {
    const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?timeout=${waitSecs}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout((waitSecs + 30) * 1000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        /* keep raw text */
    }
    if (!res.ok) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`Apify Actor run failed (HTTP ${res.status}): ${raw.slice(0, 2000)}`);
    }
    return Array.isArray(body) ? body : [body];
}

export async function callActorTool(actorId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const token = getToken();
    if (!token) return TOKEN_MISSING();
    try {
        const items = await runActor(actorId, compact(args), token);
        return ok({ items, count: items.length });
    } catch (e) {
        return fail('APIFY_ACTOR_RUN_FAILED', e instanceof Error ? e.message : String(e));
    }
}

export const READ_ONLY_REMOTE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const READ_ONLY_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
