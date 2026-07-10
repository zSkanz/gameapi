import type {
  StockRepository,
  DecreaseResult,
  AdjustResult,
  GetResult,
  SetMaxResult,
} from './stock.repository';

/**
 * Domain facade over the repository. HTTP-agnostic. Domain rules for stock (clamp at 0,
 * cap at max, get-or-create, exactly-once) live inside the atomic Lua scripts the
 * repository invokes, so this layer stays thin — it is the seam where richer cross-store
 * policy (e.g. per-key durability tiers) would live as the module grows.
 */
export class StockService {
  constructor(private readonly repo: StockRepository) {}

  decrease(gameId: string, stockKey: string, amount: number, idemKey: string, keyId: string): Promise<DecreaseResult> {
    return this.repo.decrease(gameId, stockKey, amount, idemKey, keyId);
  }

  adjust(gameId: string, stockKey: string, delta: number, idemKey: string, keyId: string): Promise<AdjustResult> {
    return this.repo.adjust(gameId, stockKey, delta, idemKey, keyId);
  }

  get(gameId: string, stockKey: string, expectedStock: number | undefined, keyId: string): Promise<GetResult> {
    return this.repo.get(gameId, stockKey, expectedStock, keyId);
  }

  setMax(gameId: string, stockKey: string, targetMax: number, idemKey: string, keyId: string): Promise<SetMaxResult> {
    return this.repo.setMax(gameId, stockKey, targetMax, idemKey, keyId);
  }

  read(gameId: string, stockKey: string) {
    return this.repo.read(gameId, stockKey);
  }
}
