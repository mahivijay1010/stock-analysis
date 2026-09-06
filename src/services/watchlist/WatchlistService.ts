/**
 * WatchlistService (Phase B2, spec §3) — "I follow this stock".
 *
 * A watchlist item is NOT a holding: adding one never creates transactions,
 * lots or P&L; removing one never touches the ledger or its history
 * (spec §13.1). Ownership is enforced on every operation — items are only
 * visible/deletable through the owning account (spec §12/§13.16).
 */
import { DataSource, In } from "typeorm";
import { AppDataSource } from "../../config/database";
import { WatchlistItem } from "../../entities/WatchlistItem";
import { Instrument } from "../../entities/Instrument";
import { HttpError } from "../../types";
import { LedgerService } from "../ledger/LedgerService";

export type Horizon = "short" | "medium" | "long";
const HORIZONS: Horizon[] = ["short", "medium", "long"];

export interface WatchlistItemView {
  id: string;
  instrumentId: string;
  ticker: string;
  name: string;
  sector: string | null;
  notes: string | null;
  /** Product labels (spec §9): short ≤30d, medium 31–365d, long >365d. */
  horizon: Horizon;
  createdAt: string;
}

export class WatchlistService {
  private readonly ledger: LedgerService;

  constructor(private readonly ds: DataSource = AppDataSource) {
    this.ledger = new LedgerService(ds);
  }

  async list(accountId: string): Promise<WatchlistItemView[]> {
    const items = await this.ds.getRepository(WatchlistItem).find({
      where: { accountId },
      order: { createdAt: "ASC" },
    });
    if (items.length === 0) return [];
    const instruments = await this.ds.getRepository(Instrument).find({
      where: { id: In(items.map((i) => i.instrumentId)) },
    });
    const byId = new Map(instruments.map((i) => [i.id, i]));
    return items.map((i) => this.view(i, byId.get(i.instrumentId)));
  }

  async add(
    accountId: string,
    input: { ticker?: string; instrumentId?: string; notes?: string; horizon?: string }
  ): Promise<WatchlistItemView> {
    const horizon = (input.horizon ?? "medium") as Horizon;
    if (!HORIZONS.includes(horizon)) {
      throw new HttpError(400, `"horizon" must be one of ${HORIZONS.join(", ")} (product labels, not tax classes).`);
    }
    const instrument = await this.ledger.resolveInstrument(input);
    const repo = this.ds.getRepository(WatchlistItem);
    const existing = await repo.findOne({ where: { accountId, instrumentId: instrument.id } });
    if (existing) {
      throw new HttpError(409, `${instrument.yahooTicker} is already on your watchlist.`);
    }
    const item = new WatchlistItem();
    item.accountId = accountId;
    item.instrumentId = instrument.id;
    item.notes = input.notes ? String(input.notes).slice(0, 2000) : null;
    item.horizon = horizon;
    const saved = await repo.save(item);
    return this.view(saved, instrument);
  }

  /**
   * Remove an item. Deletes ONLY the watchlist row — holdings, transactions
   * and history are never touched (spec §3). Unknown or foreign ids → 404
   * (no cross-account existence leak).
   */
  async remove(accountId: string, itemId: string): Promise<{ removed: true; id: string }> {
    const repo = this.ds.getRepository(WatchlistItem);
    const item = await repo.findOne({ where: { id: itemId, accountId } });
    if (!item) throw new HttpError(404, "Watchlist item not found.");
    await repo.delete({ id: item.id, accountId });
    return { removed: true, id: item.id };
  }

  private view(item: WatchlistItem, instrument?: Instrument): WatchlistItemView {
    return {
      id: item.id,
      instrumentId: item.instrumentId,
      ticker: instrument?.yahooTicker ?? "(unknown)",
      name: instrument?.name ?? "(unknown)",
      sector: instrument?.sector ?? null,
      notes: item.notes ?? null,
      horizon: item.horizon,
      createdAt: new Date(item.createdAt).toISOString(),
    };
  }
}
