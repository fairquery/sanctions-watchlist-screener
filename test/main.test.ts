import { afterEach, describe, expect, it, vi } from 'vitest';

import { countryMatches, countryTerms } from '../src/countries.js';
import { loadList } from '../src/lists.js';
import { NameIndex, nameScore, tokens, yearsOf } from '../src/match.js';

const s = (a: string, b: string) => nameScore(tokens(a), tokens(b));

describe('matching', () => {
    it('scores true matches high and different people low', () => {
        expect(s('Vladimir Putin', 'PUTIN, Vladimir Vladimirovich')).toBeGreaterThanOrEqual(95);
        expect(s('Vladimir Poutine', 'Vladimir PUTIN')).toBeGreaterThanOrEqual(90);
        expect(s('Osama bin Laden', 'Usama BIN LADIN')).toBeGreaterThanOrEqual(88);
        expect(s('Vladimir Putin', 'TYURIN, Vladimir Anatolyevich')).toBeLessThan(80);
        expect(s('Kim Jong Un', 'KIM, Jong Man')).toBeLessThan(85);
        expect(s('Rosneft', 'PJSC Rosneft Oil Company')).toBeGreaterThanOrEqual(85);
        expect(s('Müller GmbH', 'MULLER')).toBe(100);
    });
    it('index finds candidates despite typos', () => {
        const ix = new NameIndex();
        ix.add('PUTIN, Vladimir Vladimirovich', 0, false);
        ix.add('ACME TRADING LLC', 1, false);
        expect([...ix.candidates(tokens('Vladimir Poutin'))].map((i) => ix.names[i].entry)).toEqual([0]);
    });
    it('years and countries', () => {
        expect(yearsOf('DOB 07 Oct 1952; alt. DOB 1953')).toEqual([1952, 1953]);
        expect(countryMatches(countryTerms('RU'), ['Russian Federation'])).toBe(true);
        expect(countryMatches(countryTerms('KP'), ['Korea, North'])).toBe(true);
        expect(countryMatches(countryTerms('Iran'), ['Iran (Islamic Republic of)'])).toBe(true);
        expect(countryMatches(countryTerms('DE'), ['Russia'])).toBe(false);
    });
});

describe('list parsers (mocked downloads)', () => {
    afterEach(() => vi.unstubAllGlobals());
    const stub = (body: string) =>
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(body, { status: 200 })),
        );

    it('parses EU CSV 1.1 (grouped by Entity_LogicalId)', async () => {
        const h =
            'fileGenerationDate;Entity_LogicalId;Entity_EU_ReferenceNumber;Entity_DesignationDate;Entity_SubjectType_ClassificationCode;Entity_Regulation_Programme;NameAlias_WholeName;BirthDate_BirthDate;Citizenship_CountryDescription;Address_CountryDescription';
        stub(
            `${h}\n2026-10-15;13;EU.27.28;2001-10-12;person;AFG;Saddam Hussein Al-Tikriti;1937-04-28;IRAQ;\n2026-10-15;13;EU.27.28;2001-10-12;person;AFG;Abu Ali;1937-04-28;IRAQ;\n2026-10-15;20;EU.1.2;;enterprise;RUS;Acme Defence JSC;;;RUSSIAN FEDERATION\n`,
        );
        const e = await loadList('EU', 5000);
        expect(e).toHaveLength(2);
        expect(e[0]).toMatchObject({
            list: 'EU',
            id: 'EU.27.28',
            type: 'individual',
            name: 'Saddam Hussein Al-Tikriti',
            aliases: ['Abu Ali'],
            countries: ['IRAQ'],
            dob: ['1937-04-28'],
        });
        expect(e[1].type).toBe('entity');
    });
    it('parses UK Sanctions List CSV', async () => {
        stub(
            'Report Date: 16-Oct-2026\nLast Updated,Unique ID,Name 6,Name 1,Name 2,Name type,Regime Name,Designation Type,D.O.B,Nationality(/ies),Address Country\n01/01/2026,RUS0001,PUTIN,Vladimir,Vladimirovich,Primary Name,Russia,Individual,07/10/1952,Russia,\n01/01/2026,RUS0001,POUTINE,Vladimir,,Alias,Russia,Individual,07/10/1952,Russia,\n',
        );
        const e = await loadList('UK', 5000);
        expect(e).toEqual([
            expect.objectContaining({
                id: 'RUS0001',
                type: 'individual',
                name: 'Vladimir Vladimirovich PUTIN',
                aliases: ['Vladimir POUTINE'],
                programs: ['Russia'],
            }),
        ]);
    });
    it('parses UN XML', async () => {
        stub(
            '<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>ABDUL</FIRST_NAME><SECOND_NAME>BAQI</SECOND_NAME><UN_LIST_TYPE>Taliban</UN_LIST_TYPE><REFERENCE_NUMBER>TAi.024</REFERENCE_NUMBER><NATIONALITY><VALUE>Afghanistan</VALUE></NATIONALITY><INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Abdul Baqi Basir</ALIAS_NAME></INDIVIDUAL_ALIAS><INDIVIDUAL_DATE_OF_BIRTH><YEAR>1962</YEAR></INDIVIDUAL_DATE_OF_BIRTH></INDIVIDUAL></INDIVIDUALS><ENTITIES><ENTITY><FIRST_NAME>AL-QAIDA</FIRST_NAME><UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDe.004</REFERENCE_NUMBER></ENTITY></ENTITIES></CONSOLIDATED_LIST>',
        );
        const e = await loadList('UN', 5000);
        expect(e[0]).toMatchObject({
            id: 'TAi.024',
            name: 'ABDUL BAQI',
            aliases: ['Abdul Baqi Basir'],
            countries: ['Afghanistan'],
            dob: ['1962'],
        });
        expect(e[1]).toMatchObject({ id: 'QDe.004', type: 'entity' });
    });
    it('parses OFAC CSVs (primary + alt + address)', async () => {
        const files: Record<string, string> = {
            'SDN.CSV':
                '306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"a.k.a. \'BNC\'."\n7,"DOE, John",individual,"SDGT] [IRGC",-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 01 Jan 1970; nationality Iran."\n',
            'ALT.CSV': '306,1,"aka","BNC",-0-\n',
            'ADD.CSV': '306,1,"Calle 1","Havana","Cuba",-0-\n',
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async (u: string) => new Response(files[String(u).split('/').pop()!] ?? '', { status: 200 })),
        );
        const e = await loadList('OFAC_SDN', 5000);
        expect(e[0]).toMatchObject({
            id: '306',
            type: 'entity',
            aliases: ['BNC'],
            countries: ['Cuba'],
            programs: ['CUBA'],
        });
        expect(e[1]).toMatchObject({
            type: 'individual',
            programs: ['SDGT', 'IRGC'],
            dob: ['01 Jan 1970'],
            countries: ['Iran'],
        });
    });
});
