import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { Character } from '../database/entities/character.entities';
import { Monster } from '../database/entities/island.entities';
import { Crystal, Item } from '../database/entities/item.entities';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { CharactersService } from '../characters/characters.service';
import { monsterActions, MonsterAction } from '../game/m3';

export interface MonsterOffer {
  id: string;
  monster_id: string;
  character_id: string;
  crystal_count: number;
  want_item_ids: string[];
  created_at: number;
  message: string;
}

/** 怪物智慧分级与 7 级怪物交易（§4.2） */
@Injectable()
export class MonsterAiService {
  private readonly logger = new Logger(MonsterAiService.name);
  private offers = new Map<string, MonsterOffer>();

  constructor(
    @InjectRepository(Monster) private readonly monsters: Repository<Monster>,
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Crystal) private readonly crystals: Repository<Crystal>,
    private readonly charactersService: CharactersService,
    private readonly ai: AiGatewayService,
  ) {}

  /** 1–3 级本能，4–6 级战术，7 级可谈判：由模型在允许行为里挑一个 */
  async decide(monster: Monster, context: string): Promise<{ action: MonsterAction; model: boolean }> {
    const hpRatio = monster.max_hp > 0 ? monster.hp / monster.max_hp : 0;
    const allowed = monsterActions(monster.level, hpRatio);
    if (monster.level < 7) {
      return { action: this.ruleAction(monster.level, hpRatio, allowed), model: false };
    }
    const prompt = [
      `你是等级 7 的怪物「${monster.custom_name ?? '无名者'}」，已经能说人话。`,
      `当前生命 ${monster.hp}/${monster.max_hp}。${context}`,
      `可选行为：${allowed.join(' / ')}`,
      '只输出一个行为词。',
    ].join('\n');
    try {
      const reply = await this.ai.call('monster_decide', prompt, { tier: 'large', maxTokens: 12 });
      const hit = allowed.find((action) => reply.toLowerCase().includes(action));
      return { action: hit ?? 'attack', model: true };
    } catch {
      return { action: this.ruleAction(7, hpRatio, allowed), model: false };
    }
  }

  /** 7 级怪物主动提出交易：用晶核换随身物资 */
  async offerTrade(monsterId: string, characterId: string): Promise<MonsterOffer> {
    const monster = await this.monsters.findOne({ where: { id: monsterId } });
    if (!monster) throw new Error('怪物不存在');
    if (monster.level < 7) throw new Error('它还没学会说话');
    if (monster.state === 'dead' || monster.hp <= 0) throw new Error('它已经死了');
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    if (character.island_id !== monster.island_id) throw new Error('它不在你附近');

    const carried = await this.items.find({ where: { owner_type: 'character', owner_id: character.id }, take: 6 });
    if (carried.length === 0) throw new Error('你身上没有它看得上的东西');
    const offer: MonsterOffer = {
      id: randomUUID(),
      monster_id: monster.id,
      character_id: character.id,
      crystal_count: Math.max(1, Math.floor(monster.level / 7)),
      want_item_ids: carried.slice(0, Math.min(2, carried.length)).map((item) => item.id),
      created_at: Date.now(),
      message: '它把一枚晶核放在地上，用下巴点了点你腰间的东西。',
    };
    this.offers.set(offer.id, offer);
    return offer;
  }

  async acceptTrade(characterId: string, offerId: string) {
    const offer = this.offers.get(offerId);
    if (!offer) throw new Error('这个交易已经不存在了');
    if (offer.character_id !== characterId) throw new Error('这不是给你的交易');
    if (Date.now() - offer.created_at > 5 * 60 * 1000) {
      this.offers.delete(offerId);
      throw new Error('它已经不耐烦了');
    }
    const items = await this.items.find({
      where: { id: In(offer.want_item_ids), owner_type: 'character', owner_id: characterId },
    });
    if (items.length === 0) throw new Error('东西已经不在你身上了');

    for (const item of items) {
      item.owner_type = 'monster';
      item.owner_id = offer.monster_id;
      await this.items.save(item);
    }
    await this.crystals.save(
      this.crystals.create({
        id: randomUUID(),
        level: 7,
        energy_total: 100 ** 6,
        energy_remaining: 100 ** 6,
        holder_type: 'character',
        holder_id: characterId,
        x: null,
        y: null,
        created_at: new Date(),
      }),
    );
    this.offers.delete(offerId);
    return {
      ok: true,
      got_crystals: offer.crystal_count,
      gave: items.map((item) => `${item.name}×${item.quantity}`),
      narration: '它收下东西，把晶核推过来，然后退回雾里。',
    };
  }

  listOffers(characterId: string) {
    const now = Date.now();
    return [...this.offers.values()]
      .filter((offer) => offer.character_id === characterId && now - offer.created_at < 5 * 60 * 1000)
      .map((offer) => ({ offer_id: offer.id, crystal_count: offer.crystal_count, want_count: offer.want_item_ids.length, message: offer.message }));
  }

  private ruleAction(level: number, hpRatio: number, allowed: MonsterAction[]): MonsterAction {
    if (allowed.includes('flee') && hpRatio <= 0.25) return 'flee';
    if (level >= 7 && allowed.includes('trap') && Math.random() < 0.2) return 'trap';
    if (level >= 5 && allowed.includes('talk') && Math.random() < 0.15) return 'talk';
    if (level >= 4 && allowed.includes('focus') && Math.random() < 0.4) return 'focus';
    return 'attack';
  }
}
