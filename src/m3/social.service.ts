import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { Character, Ship, Team } from '../database/entities/character.entities';
import { DeadDrop, Item } from '../database/entities/item.entities';
import { CharactersService } from '../characters/characters.service';
import { WorldService } from '../world/world.service';
import { distanceNm, round1 } from '../game/geo';
import { canTradeAt, displayNameWithTeam } from '../game/m3';

const TRADE_TTL_MS = 5 * 60 * 1000;

interface PendingTrade {
  id: string;
  fromId: string;
  toId: string;
  offerIds: string[];
  wantIds: string[];
  createdAt: number;
}

/** 团队系统（§3 团队多人协作） */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);
  private invites = new Map<string, string>(); // 被邀请角色 → 团队
  private showTitle = new Map<string, boolean>();

  constructor(
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Ship) private readonly ships: Repository<Ship>,
    private readonly charactersService: CharactersService,
  ) {}

  async create(characterId: string, rawName: string): Promise<{ team: Team; character: Character }> {
    const character = await this.must(characterId);
    if (character.team_id) throw new Error('你已经在队伍中，先退出原队伍');
    const name = this.cleanName(rawName);
    const team = await this.teams.save(
      this.teams.create({ id: randomUUID(), name, captain_id: characterId, created_at: new Date() }),
    );
    character.team_id = team.id;
    await this.characters.save(character);
    this.showTitle.set(team.id, true);
    return { team, character };
  }

  async invite(characterId: string, targetName: string): Promise<{ target: Character; team: Team }> {
    const captain = await this.must(characterId);
    const team = await this.teamOf(captain);
    if (!team || team.captain_id !== captain.id) throw new Error('只有队长可以邀请');
    const target = await this.characters.findOne({ where: { name: targetName.trim() } });
    if (!target) throw new Error('找不到这个角色');
    if (target.id === captain.id) throw new Error('不能邀请自己');
    if (target.team_id) throw new Error('对方已经在队伍中');
    this.invites.set(target.id, team.id);
    return { target, team };
  }

  async join(characterId: string): Promise<{ team: Team; character: Character }> {    const character = await this.must(characterId);
    const teamId = this.invites.get(character.id);
    if (!teamId) throw new Error('没有待接受的邀请');
    const team = await this.teams.findOne({ where: { id: teamId } });
    if (!team) {
      this.invites.delete(character.id);
      throw new Error('队伍已解散');
    }
    if (character.team_id) throw new Error('你已经在队伍中');
    character.team_id = team.id;
    await this.characters.save(character);
    this.invites.delete(character.id);
    return { team, character };
  }

  /** 文字入队：按队名直接加入（M3.5 简化，队满 5 人拒绝） */
  async joinByName(characterId: string, teamName: string): Promise<{ team: Team; character: Character }> {
    const character = await this.must(characterId);
    if (character.team_id) throw new Error('你已经在队伍中');
    const name = (teamName ?? '').trim();
    if (!name) throw new Error('告诉我队名');
    const team = await this.teams.findOne({ where: { name } });
    if (!team) throw new Error(`没有找到队伍「${name}」`);
    const count = await this.characters.count({ where: { team_id: team.id } });
    if (count >= 5) throw new Error('队伍已满（最多 5 人）');
    character.team_id = team.id;
    await this.characters.save(character);
    return { team, character };
  }

  async leave(characterId: string): Promise<{ team: Team | null; character: Character; dissolved: boolean }> {
    const character = await this.must(characterId);
    if (!character.team_id) throw new Error('你不在队伍中');
    const team = await this.teams.findOne({ where: { id: character.team_id } });
    character.team_id = null;
    await this.characters.save(character);
    if (!team) return { team: null, character, dissolved: true };

    const members = await this.characters.find({ where: { team_id: team.id } });
    if (members.length === 0) {
      await this.teams.delete({ id: team.id });
      this.showTitle.delete(team.id);
      return { team: null, character, dissolved: true };
    }
    if (team.captain_id === characterId) {
      team.captain_id = members[0].id;
      await this.teams.save(team);
    }
    return { team, character, dissolved: false };
  }

  async disband(characterId: string): Promise<{ dissolved: boolean }> {
    const captain = await this.must(characterId);
    const team = await this.teamOf(captain);
    if (!team) throw new Error('你不在队伍中');
    if (team.captain_id !== captain.id) throw new Error('只有队长可以解散队伍');
    await this.characters.update({ team_id: team.id }, { team_id: null });
    await this.teams.delete({ id: team.id });
    this.showTitle.delete(team.id);
    return { dissolved: true };
  }

  toggleTitle(characterId: string, show: boolean): { show_title: boolean } {
    return { show_title: this.setTitle(characterId, show) };
  }

  private setTitle(characterId: string, show: boolean): boolean {
    void characterId;
    // 称号展示按队伍维度保存；调用方在 info 中读取
    return show;
  }

  setTeamTitle(teamId: string, show: boolean): void {
    this.showTitle.set(teamId, show);
  }

  isTitleShown(teamId: string | null | undefined): boolean {
    if (!teamId) return false;
    return this.showTitle.get(teamId) ?? true;
  }

  async info(characterId: string) {
    const character = await this.must(characterId);
    if (!character.team_id) return { in_team: false, team: null, members: [] };
    const team = await this.teams.findOne({ where: { id: character.team_id } });
    if (!team) return { in_team: false, team: null, members: [] };
    const members = await this.characters.find({ where: { team_id: team.id } });
    return {
      in_team: true,
      team: { id: team.id, name: team.name, captain_id: team.captain_id, show_title: this.isTitleShown(team.id) },
      members: members.map((member) => ({
        id: member.id,
        name: this.nameOf(member, team),
        level: member.level,
        aptitude: member.aptitude,
        hp: member.hp,
        max_hp: member.max_hp,
        is_captain: member.id === team.captain_id,
        ship_id: member.ship_id,
        island_id: member.island_id,
      })),
    };
  }

  /** 上队长的船：同岛或 0.5 海里内 */
  async board(characterId: string, captainName: string): Promise<{ character: Character; ship: Ship }> {
    const character = await this.must(characterId);
    const team = await this.teamOf(character);
    if (!team) throw new Error('你不在队伍中');
    const captain = await this.must(team.captain_id);
    if (captain.id === character.id) throw new Error('你就是船长');
    if (captain.island_id !== character.island_id) {
      if (captain.island_id || character.island_id) throw new Error('队长不在同一座岛上');
      if (distanceNm(captain.x, captain.y, character.x, character.y) > 0.5) throw new Error('离队长太远，靠过去再上船');
    }
    const ship = await this.charactersService.getShip(captain.ship_id);
    if (!ship) throw new Error('队长没有可用的船');
    character.ship_id = ship.id;
    character.x = ship.x;
    character.y = ship.y;
    character.island_id = captain.island_id;
    await this.characters.save(character);
    void captainName;
    return { character, ship };
  }

  /** 下船，回到自己的船（没有则留在原地） */
  async disembark(characterId: string): Promise<{ character: Character; ship: Ship | null }> {
    const character = await this.must(characterId);
    const own = await this.ships.findOne({ where: { captain_id: character.id } });
    if (own) {
      own.x = character.x;
      own.y = character.y;
      await this.ships.save(own);
    }
    character.ship_id = own ? own.id : null;
    await this.characters.save(character);
    return { character, ship: own };
  }

  async crewCount(shipId: string | null): Promise<number> {
    if (!shipId) return 1;
    const count = await this.characters.count({ where: { ship_id: shipId } });
    return Math.max(1, count);
  }

  nameOf(character: Character, team: Team | null): string {
    return displayNameWithTeam(character.name, team ? team.name : null, team ? this.isTitleShown(team.id) : false);
  }

  async teamOf(character: Character): Promise<Team | null> {
    if (!character.team_id) return null;
    return this.teams.findOne({ where: { id: character.team_id } });
  }

  private async must(characterId: string): Promise<Character> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    return character;
  }

  private cleanName(raw: string): string {
    const name = (raw ?? '').trim().slice(0, 12);
    if (name.length < 2) throw new Error('队伍名字至少 2 个字');
    return name;
  }
}

/** 物理交易与藏匿点（§3 交易、§4.1 地面物品） */
@Injectable()
export class TradeService {
  private readonly logger = new Logger(TradeService.name);
  private pending = new Map<string, PendingTrade>();

  constructor(
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(DeadDrop) private readonly drops: Repository<DeadDrop>,
    private readonly charactersService: CharactersService,
    private readonly world: WorldService,
  ) {}

  async propose(
    characterId: string,
    targetName: string,
    offerIds: string[],
    wantIds: string[],
  ): Promise<{ trade_id: string; expires_in: number; offer: any[]; want: any[] }> {
    const from = await this.must(characterId);
    const to = await this.characters.findOne({ where: { name: (targetName ?? '').trim() } });
    if (!to) throw new Error('找不到这个角色');
    if (to.id === from.id) throw new Error('不能和自己交易');
    if (to.status === 'dead') throw new Error('对方已经死了');
    if (!canTradeAt(from, to)) throw new Error('你们不在同一座岛，也不是同在海上，交易做不了');

    const offer = await this.owned(from.id, offerIds);
    const want = await this.owned(to.id, wantIds);
    if (offer.length === 0 && want.length === 0) throw new Error('至少给出或索要一样东西');

    const trade: PendingTrade = {
      id: randomUUID(),
      fromId: from.id,
      toId: to.id,
      offerIds: offer.map((item) => item.id),
      wantIds: want.map((item) => item.id),
      createdAt: Date.now(),
    };
    this.pending.set(trade.id, trade);
    return {
      trade_id: trade.id,
      expires_in: Math.round(TRADE_TTL_MS / 1000),
      offer: offer.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity })),
      want: want.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity })),
    };
  }

  async accept(characterId: string, tradeId: string) {
    const trade = this.pending.get(tradeId);
    if (!trade) throw new Error('交易不存在或已过期');
    if (Date.now() - trade.createdAt > TRADE_TTL_MS) {
      this.pending.delete(tradeId);
      throw new Error('交易已过期');
    }
    if (trade.toId !== characterId) throw new Error('这笔交易不是给你的');
    const from = await this.must(trade.fromId);
    const to = await this.must(trade.toId);
    if (!canTradeAt(from, to)) {
      this.pending.delete(tradeId);
      throw new Error('你们已经不在同一处，交易取消');
    }

    const offer = await this.owned(from.id, trade.offerIds);
    const want = await this.owned(to.id, trade.wantIds);
    if (offer.length !== trade.offerIds.length || want.length !== trade.wantIds.length) {
      this.pending.delete(tradeId);
      throw new Error('物品已发生变化，交易取消');
    }

    for (const item of offer) {
      item.owner_type = 'character';
      item.owner_id = to.id;
      item.x = null;
      item.y = null;
      await this.items.save(item);
    }
    for (const item of want) {
      item.owner_type = 'character';
      item.owner_id = from.id;
      item.x = null;
      item.y = null;
      await this.items.save(item);
    }
    this.pending.delete(tradeId);
    return {
      ok: true,
      gave: offer.map((item) => `${item.name}×${item.quantity}`),
      got: want.map((item) => `${item.name}×${item.quantity}`),
      narration: `你们在甲板上把东西递了过去，${offer.length} 件换 ${want.length} 件，谁也没多说一句。`,
    };
  }

  decline(characterId: string, tradeId: string): { ok: boolean } {
    const trade = this.pending.get(tradeId);
    if (!trade) throw new Error('交易不存在或已过期');
    if (trade.toId !== characterId && trade.fromId !== characterId) throw new Error('这笔交易与你无关');
    this.pending.delete(tradeId);
    return { ok: true };
  }

  list(characterId: string) {
    const now = Date.now();
    const incoming = [...this.pending.values()]
      .filter((trade) => trade.toId === characterId && now - trade.createdAt <= TRADE_TTL_MS)
      .map((trade) => ({ trade_id: trade.id, from: trade.fromId, offer_count: trade.offerIds.length, want_count: trade.wantIds.length }));
    return { incoming };
  }

  /** 放置藏匿点：物品落到脚下，任何人在 0.2 海里内都能取走 */
  async placeDrop(characterId: string, itemIds: string[]): Promise<{ drop_id: string; count: number; x: number; y: number }> {
    const character = await this.must(characterId);
    const owned = await this.owned(character.id, itemIds);
    if (owned.length === 0) throw new Error('你身上没有这些东西');
    const state = await this.world.getState();
    const drop = await this.drops.save(
      this.drops.create({
        id: randomUUID(),
        placer_character_id: character.id,
        x: character.x,
        y: character.y,
        item_ids: owned.map((item) => item.id),
        created_world_day: state.world_day,
        discovered_by: null,
      }),
    );
    for (const item of owned) {
      item.owner_type = 'ground';
      item.owner_id = drop.id;
      item.x = character.x;
      item.y = character.y;
      await this.items.save(item);
    }
    return { drop_id: drop.id, count: owned.length, x: round1(character.x), y: round1(character.y) };
  }

  async takeDrop(characterId: string, dropId: string) {
    const character = await this.must(characterId);
    const drop = await this.drops.findOne({ where: { id: dropId } });
    if (!drop) throw new Error('这里没有东西');
    if (distanceNm(character.x, character.y, drop.x, drop.y) > 0.2) throw new Error('离得太远，够不着');
    const ids: string[] = Array.isArray(drop.item_ids) ? drop.item_ids : [];
    const items = ids.length ? await this.items.find({ where: { id: In(ids), owner_id: drop.id } }) : [];
    if (items.length === 0) {
      await this.drops.delete({ id: drop.id });
      throw new Error('这里已经被搬空了');
    }
    for (const item of items) {
      item.owner_type = 'character';
      item.owner_id = character.id;
      item.x = null;
      item.y = null;
      await this.items.save(item);
    }
    drop.discovered_by = character.id;
    await this.drops.save(drop);
    return {
      ok: true,
      got: items.map((item) => `${item.name}×${item.quantity}`),
      narration: `你蹲下去，把${items[0].name}从藏匿处拖了出来，甲板上的锈屑掉了一地。`,
    };
  }

  async dropsNear(x: number, y: number, radius = 5) {    const all = await this.drops.find({ take: 50, order: { created_world_day: 'DESC' } });
    return all
      .filter((drop) => distanceNm(x, y, drop.x, drop.y) <= radius)
      .map((drop) => ({ drop_id: drop.id, distance: round1(distanceNm(x, y, drop.x, drop.y)), world_day: drop.created_world_day }));
  }

  // ------------------------------------------------------------ 对话式交易辅助

  async itemsOf(characterId: string): Promise<{ id: string; name: string; quantity: number }[]> {
    const rows = await this.items.find({ where: { owner_type: 'character', owner_id: characterId }, take: 40 });
    return rows.map((row) => ({ id: row.id, name: row.name, quantity: row.quantity }));
  }

  /** 按名字找随身物；支持“零件”“药”这类简称 */
  async findOwnedByName(characterId: string, keyword: string): Promise<Item[]> {
    const clean = (keyword ?? '').trim();
    if (!clean) return [];
    const rows = await this.items.find({ where: { owner_type: 'character', owner_id: characterId } });
    const exact = rows.filter((row) => row.name === clean);
    if (exact.length > 0) return exact;
    return rows.filter((row) => row.name.includes(clean) || clean.includes(row.name));
  }

  /** 某个角色收到的待处理交易（最近一笔） */
  async pendingFor(characterId: string): Promise<{ trade_id: string; from_id: string; from_name: string; offer: string[]; want: string[] } | null> {
    const now = Date.now();
    const entries = [...this.pending.values()]
      .filter((trade) => trade.toId === characterId && now - trade.createdAt <= TRADE_TTL_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
    const trade = entries[0];
    if (!trade) return null;
    const from = await this.characters.findOne({ where: { id: trade.fromId } });
    const offer = await this.namesOf(trade.offerIds);
    const want = await this.namesOf(trade.wantIds);
    return { trade_id: trade.id, from_id: trade.fromId, from_name: from?.name ?? '有人', offer, want };
  }

  private async namesOf(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.items.find({ where: { id: In(ids) } });
    return rows.map((row) => `${row.name}×${row.quantity}`);
  }

  private async owned(characterId: string, ids: string[]): Promise<Item[]> {
    const clean = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id.length > 0))];
    if (clean.length === 0) return [];
    return this.items.find({ where: { id: In(clean), owner_type: 'character', owner_id: characterId } });
  }

  private async must(characterId: string): Promise<Character> {
    const character = await this.charactersService.get(characterId);
    if (!character) throw new Error('角色不存在');
    return character;
  }
}

