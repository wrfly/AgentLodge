/** The price table: four unit prices per model */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import * as pricing from '../../../core/db/pricing.js';
import { describePeak, isPeakAt } from '../../../core/peak-hours.js';
import { getString } from '../../../core/db/settings.js';
import { guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  /*
   * The rows, and the currency they are supposed to be in.
   *
   * The column is per row, so the table cannot say on its own which money a *new* row belongs
   * in — the interface was reading that off whatever row happened to be first. This is the
   * platform's answer, which is the one the form's labels want.
   */
  app.get('/api/admin/pricing', guard, async () => {
    /*
     * The schedule is rendered here rather than in the browser. describePeak lives beside
     * the code that evaluates the windows, and a second copy on the web side is a copy that
     * can disagree with the one deciding the bill — the console would then describe a
     * surcharge that is not the one being applied. `peakNow` is the same argument: whether
     * this instant is inside a window is answered by the process that would charge for it.
     */
    const now = new Date();
    return {
      currency: getString('billing.currency', 'USD'),
      rows: pricing.list().map((r) => ({
        ...r,
        peakLabel: describePeak(r.peakWindows),
        peakNow: isPeakAt(r.peakWindows, now),
      })),
    };
  });

  app.post('/api/admin/pricing', guard, async (req, reply) => {
    const body = (req.body ?? {}) as {
      model?: string;
      currency?: string;
      /** The interface takes a price per million tokens; this converts to micro-units */
      priceInput?: number;
      priceCacheRead?: number;
      priceCacheWrite?: number;
      priceOutput?: number;
      /** Which upstream this price is for. Empty applies to any of them. */
      providerId?: string;
      note?: string;
    };
    if (!body.model?.trim()) return reply.code(400).send({ error: tr(req, 'Missing model name') });

    /*
     * Refuse what cannot be a price, rather than coercing it.
     *
     * `Number(v ?? 0)` took anything: a browser sending `null` — which is what
     * JSON.stringify does with the NaN that `Number('1,5')` produces — became 0, and the
     * row was inserted, returned 200, and priced that model at nothing. Five of the nine
     * shipped locales write decimals with a comma, so this was reachable by typing the
     * number the way the interface's own language writes it. A negative went through the
     * same way and credited quota instead of consuming it.
     */
    const FIELDS = ['priceInput', 'priceCacheRead', 'priceCacheWrite', 'priceOutput'] as const;
    for (const f of FIELDS) {
      const v = body[f];
      if (v === undefined || v === null) continue; // absent means zero, which is a real price
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return reply.code(400).send({ error: tr(req, 'Prices have to be numbers, written with a dot') });
      }
      if (v < 0) return reply.code(400).send({ error: tr(req, 'A price cannot be negative') });
    }

    const yuan = (v: unknown) => Math.round(Number(v ?? 0) * pricing.MICRO);
    const row = pricing.add({
      model: body.model,
      providerId: body.providerId,
      currency: body.currency,
      priceInput: yuan(body.priceInput),
      priceCacheRead: yuan(body.priceCacheRead),
      priceCacheWrite: yuan(body.priceCacheWrite),
      priceOutput: yuan(body.priceOutput),
      note: body.note,
    });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.pricing.add',
      detail: { model: body.model },
      ip: req.ip,
    });
    return row;
  });

  app.delete('/api/admin/pricing/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };

    /*
     * The last catch-all cannot be deleted.
     *
     * It is two things at once: the price of every model without a row of its own, and the
     * unit billable tokens are counted in — a turn's cost divided by one input token at
     * this rate. Take it away and resolve() returns undefined, costMicro returns 0, and
     * every unpriced model becomes free while quota silently falls back to flat weights.
     * None of that raises anything; the table just stops answering.
     *
     * Superseded '*' rows are still removable, which is the actual housekeeping somebody
     * wants: a price change appends, so old catch-alls accumulate. Only the one that would
     * leave none is refused.
     */
    const rows = pricing.list();
    const doomed = rows.find((r) => r.id === Number(id));
    if (doomed?.model === '*' && !doomed.providerId) {
      const others = rows.filter((r) => r.model === '*' && !r.providerId && r.id !== doomed.id);
      if (!others.length) {
        return reply.code(400).send({
          error: tr(req, 'The catch-all price cannot be removed — it prices every model without a row of its own, and is the unit quota is counted in. Add a replacement first.'),
        });
      }
    }

    if (!pricing.remove(Number(id))) return reply.code(404).send({ error: tr(req, 'No such price') });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.pricing.remove',
      // A delete is the more damaging of the two operations and was the one leaving no trace
      detail: { model: doomed?.model, effectiveFrom: doomed?.effectiveFrom },
      ip: req.ip,
    });
    return { ok: true };
  });
}
