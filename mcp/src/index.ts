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

const server = new McpServer({ name: 'fairquery-sanctions-screener', version: '1.0.0' });

server.registerTool(
    'screen_names',
    {
        title: 'Screen names against sanctions lists',
        description:
            'Fuzzy-match people or company names against OFAC SDN + Consolidated, EU, UK and UN sanctions lists downloaded fresh from the official sources. One row per name: status potential_match/no_match, best_score (0-100), matches with list, entry id, primary name, aliases, programs, countries, DOB, country_match/dob_match. Optional per-name country and dateOfBirth filters. Runs Apify Actor fairquery/sanctions-watchlist-screener; requires APIFY_TOKEN, billed per name. ' +
            DISCLAIMER,
        inputSchema: {
            names: z.array(z.string().min(1)).optional().describe('Names to screen'),
            queries: z
                .array(z.object({ name: z.string().min(1), id: z.string().optional(), country: z.string().optional(), dateOfBirth: z.string().optional(), entityType: z.enum(['individual', 'entity', 'any']).optional() }))
                .optional()
                .describe('Names with optional country (ISO-2 or name), dateOfBirth (YYYY or YYYY-MM-DD), entityType'),
            lists: z.array(z.enum(LISTS)).optional().describe('Default: all five'),
            minScore: z.number().int().min(60).max(100).optional().describe('Default 85'),
            maxMatchesPerName: z.number().int().min(1).max(100).optional(),
            entityType: z.enum(['individual', 'entity', 'any']).optional(),
            excludeNonMatchingCountry: z.boolean().optional(),
        },
        outputSchema: {
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=screening or type=error'),
            count: z.number(),
        },
        annotations: { title: 'Screen names', ...READ_ONLY_REMOTE },
    },
    async (args) => callActorTool(ACTOR_ID, args),
);

server.registerTool(
    'list_sources',
    {
        title: 'List covered sanctions sources (free)',
        description: 'Free, local, no token: the official lists screen_names checks (id, name, authority, download URL), the score scale and the disclaimer. Use it to pick the lists parameter or to cite sources.',
        inputSchema: {},
        outputSchema: {
            sources: z.array(z.object({ id: z.string(), name: z.string(), authority: z.string(), url: z.string() })),
            score_scale: z.string(),
            disclaimer: z.string(),
        },
        annotations: { title: 'List sources', ...READ_ONLY_LOCAL },
    },
    async () => ok({ sources: SOURCES, score_scale: '0-100 fuzzy name similarity (Jaro-Winkler token coverage, order- and diacritics-insensitive); default threshold 85', disclaimer: DISCLAIMER }),
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
    console.error('fairquery-sanctions-screener MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
