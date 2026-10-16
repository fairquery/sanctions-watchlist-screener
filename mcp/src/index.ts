#!/usr/bin/env node
/**
 * Fairquery stdio MCP server for Apify Actor fairquery/sanctions-watchlist-screener.
 * Tools: screen_names (runs the Actor, needs APIFY_TOKEN) and list_sources (free, local).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { callActorTool, ok, READ_ONLY_LOCAL, READ_ONLY_REMOTE } from './common.js';

const ACTOR_ID = 'fairquery~sanctions-watchlist-screener';
const DISCLAIMER =
    'Not a certified screening service. Automated fuzzy matching against public lists downloaded at run time; results can contain false positives and miss matches. Review every potential match manually and consult official sources and legal counsel before acting.';
const LISTS = ['OFAC_SDN', 'OFAC_CONS', 'EU', 'UK', 'UN'] as const;

const SOURCES = [
    { id: 'OFAC_SDN', name: 'OFAC Specially Designated Nationals (SDN) List', authority: 'US Treasury OFAC', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV' },
    { id: 'OFAC_CONS', name: 'OFAC Consolidated (non-SDN) Sanctions List', authority: 'US Treasury OFAC', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONS_PRIM.CSV' },
    { id: 'EU', name: 'EU Consolidated Financial Sanctions List', authority: 'European Commission (DG FISMA)', url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content' },
    { id: 'UK', name: 'UK Sanctions List (incl. OFSI asset-freeze targets)', authority: 'UK FCDO / HM Treasury OFSI', url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv' },
    { id: 'UN', name: 'UN Security Council Consolidated List', authority: 'United Nations Security Council', url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml' },
];

const server = new McpServer({ name: 'fairquery-sanctions-screener', version: '1.0.1' });

server.registerTool(
    'screen_names',
    {
        title: 'Screen names against sanctions lists',
        description: [
            'WHAT: Fuzzy-match people or organisation names against the OFAC SDN, OFAC Consolidated (non-SDN), EU, UK and UN sanctions lists, downloaded fresh from the official sources on every run. Order-, case- and diacritics-insensitive; optional country and date-of-birth filters per name.',
            'WHEN TO USE: KYC/KYB onboarding, vendor or counterparty checks, bulk re-screening of customer lists. Put all names into one call (lists are downloaded once per run).',
            'WHEN NOT TO USE: to see which lists/authorities are covered or to cite sources, call list_sources (free). Not a PEP/adverse-media check, not a certified screening service.',
            'COST: paid. Runs Apify Actor fairquery/sanctions-watchlist-screener with your APIFY_TOKEN; pay-per-event "name-screened", once per name that gets a screening row (nothing charged if no list could be downloaded). List download takes ~10-40 s, then hundreds of names/s.',
            'RETURNS: {count, items}. type="screening" row per name: query, status (potential_match | no_match), best_score 0-100, match_count, matches[] (list, entry id, primary name, aliases, programs, countries, DOB, score, country_match, dob_match), lists_screened, lists_unavailable, min_score, screened_at, disclaimer; or type="error" rows (code, message).',
            'EXAMPLE: {"queries":[{"name":"Banco Nacional de Cuba","entityType":"entity"}],"minScore":90} -> one screening row, status potential_match with OFAC_SDN matches.',
            'Provide names and/or queries (at least one). ' + DISCLAIMER,
        ].join('\n'),
        inputSchema: {
            names: z
                .array(z.string().min(1))
                .optional()
                .describe('Plain names of people or organisations to screen, e.g. ["Vladimir Putin","Acme Trading LLC"]. Optional if queries is given.'),
            queries: z
                .array(
                    z.object({
                        name: z.string().min(1).describe('Person or organisation name to screen, e.g. "Ali Khamenei"'),
                        id: z.string().optional().describe('Your own reference echoed in the output row, e.g. "cust-42"'),
                        country: z.string().optional().describe('ISO-2 code ("IR") or country name; adds country_match to each match'),
                        dateOfBirth: z.string().optional().describe('YYYY or YYYY-MM-DD, e.g. "1939-04-19"; drops listed individuals whose birth year differs by more than 1 year'),
                        entityType: z.enum(['individual', 'entity', 'any']).optional().describe('Restrict to individuals or entities (organisations/vessels); overrides the top-level entityType'),
                    }),
                )
                .optional()
                .describe('Names with per-name filters. Example: [{"name":"Ali Khamenei","id":"cust-42","country":"IR","dateOfBirth":"1939","entityType":"individual"}]. Optional if names is given.'),
            lists: z
                .array(z.enum(LISTS))
                .optional()
                .describe('Lists to screen against: OFAC_SDN, OFAC_CONS, EU, UK, UN. Default: all five. Example: ["OFAC_SDN","EU"].'),
            minScore: z
                .number()
                .int()
                .min(60)
                .max(100)
                .optional()
                .describe('Fuzzy name-score threshold 60-100 (default 85). Use 90+ for fewer false positives, ~80 for more recall.'),
            maxMatchesPerName: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe('Top matches returned per name, 1-100 (default 10); match_count still reports the total.'),
            entityType: z
                .enum(['individual', 'entity', 'any'])
                .optional()
                .describe('Default entity filter for all names: "any" (default), "individual" or "entity". A query\'s own entityType wins.'),
            excludeNonMatchingCountry: z
                .boolean()
                .optional()
                .describe('Default false. If true, matches whose listed countries do not include the query country are removed (entries without country data are kept). Needs queries[].country.'),
        },
        outputSchema: {
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=screening or type=error'),
            count: z.number().describe('Number of rows in items'),
        },
        annotations: { title: 'Screen names', ...READ_ONLY_REMOTE },
    },
    async (args) => callActorTool(ACTOR_ID, args),
);

server.registerTool(
    'list_sources',
    {
        title: 'List covered sanctions sources (free)',
        description: [
            'WHAT: Static list of the official sanctions lists screen_names checks (id, name, issuing authority, download URL), the 0-100 score scale and the legal disclaimer.',
            'WHEN TO USE: to choose the lists parameter for screen_names, cite sources in a report, or explain coverage.',
            'WHEN NOT TO USE: to screen a name - use screen_names. Does not download lists or report list freshness.',
            'COST: free; local, no network, no APIFY_TOKEN, deterministic.',
            'RETURNS: {sources:[{id,name,authority,url}], score_scale, disclaimer}. Takes no arguments.',
            'EXAMPLE: {} -> {"sources":[{"id":"OFAC_SDN","authority":"US Treasury OFAC",...},...]}',
        ].join('\n'),
        inputSchema: {},
        outputSchema: {
            sources: z.array(z.object({ id: z.string(), name: z.string(), authority: z.string(), url: z.string() })).describe('Covered lists; id is the value for screen_names.lists'),
            score_scale: z.string().describe('How best_score is computed'),
            disclaimer: z.string().describe('Legal disclaimer to show with results'),
        },
        annotations: { title: 'List sources', ...READ_ONLY_LOCAL },
    },
    async () => ok({ sources: SOURCES, score_scale: '0-100 fuzzy name similarity (Jaro-Winkler token coverage, order- and diacritics-insensitive); default threshold 85', disclaimer: DISCLAIMER }),
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
    console.error('fairquery-sanctions-screener MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
