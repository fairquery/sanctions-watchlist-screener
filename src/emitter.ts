import { Actor, log } from 'apify';

export type Charges = Record<string, number> | string | null;

/**
 * Buffers dataset rows and pushes/charges them in batches.
 * One pushData + one Actor.charge({count}) per event per batch instead of 2 API calls per row.
 * Rows are always saved before they are charged; rows with charges=null (errors) are never charged.
 * Actor.charge only runs when the run is pay-per-event.
 */
export class Emitter {
    private buf: { row: object; charges: Charges }[] = [];
    private ppe: boolean | null = null;
    limitReached = false;
    readonly charged: Record<string, number> = {};

    constructor(private readonly batchSize = 50) {}

    async emit(row: object, charges: Charges): Promise<void> {
        this.buf.push({ row, charges });
        if (this.buf.length >= this.batchSize) await this.flush();
    }

    async flush(): Promise<void> {
        if (!this.buf.length) return;
        const batch = this.buf;
        this.buf = [];
        await Actor.pushData(batch.map((b) => b.row));
        const counts = new Map<string, number>();
        for (const b of batch) {
            if (!b.charges) continue;
            const c = typeof b.charges === 'string' ? { [b.charges]: 1 } : b.charges;
            for (const [k, n] of Object.entries(c)) if (n > 0) counts.set(k, (counts.get(k) ?? 0) + n);
        }
        for (const [k, n] of counts) this.charged[k] = (this.charged[k] ?? 0) + n;
        if (!this.isPpe()) return;
        for (const [eventName, count] of counts) {
            try {
                const res = await Actor.charge({ eventName, count });
                if (res.eventChargeLimitReached) {
                    log.warning(`Charge limit reached for ${eventName}`);
                    this.limitReached = true;
                }
            } catch (e) {
                log.debug(`Actor.charge failed for ${eventName}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    private isPpe(): boolean {
        if (this.ppe === null) {
            try {
                this.ppe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
            } catch {
                this.ppe = false;
            }
        }
        return this.ppe;
    }
}
