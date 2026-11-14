import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Character, ExperienceLog, Ship, Skill } from '../database/entities/character.entities';
import { APTITUDES, GAME } from '../game/constants';

@Injectable()
export class CharactersService {
  constructor(
    @InjectRepository(Character) private readonly characters: Repository<Character>,
    @InjectRepository(Ship) private readonly ships: Repository<Ship>,
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(ExperienceLog) private readonly logs: Repository<ExperienceLog>,
  ) {}

  /** 新手出生在 (0,0) 附近 3 海里内（出生区，§4.1） */
  private spawnPoint(): { x: number; y: number } {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 3;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  async create(userId: string, rawName: string, protectionLevel = 0): Promise<{ character: Character; ship: Ship }> {
    const name = (rawName ?? '').trim();
    if (name.length < 2 || name.length > 12) throw new Error('角色名长度需为 2–12 个字符');
    if (/[<>/\s]/.test(name)) throw new Error('角色名不能包含空格或特殊符号');
    const exists = await this.characters.findOne({ where: { name } });
    if (exists) throw new Error('这个角色名已经被用掉了');

    const count = await this.characters.count({ where: { user_id: userId } });
    if (count >= 3) throw new Error('M1 原型每个账号最多 1–3 个角色，请继续使用已有角色');

    const pos = this.spawnPoint();
    const ship = await this.ships.save(
      this.ships.create({
        id: randomUUID(),
        captain_id: null,
        name: `${name}的船`,
        durability: 100,
        max_durability: 100,
        speed: GAME.BASE_SHIP_SPEED,
        cargo_capacity: 20,
        weapon_power: 0,
        defense_lv: 0,
        weapon_lv: 0,
        living_lv: 0,
        research_lv: 0,
        fuel: GAME.INITIAL_FUEL,
        x: pos.x,
        y: pos.y,
        hp: 100,
        max_hp: 100,
      }),
    );

    const aptitude = APTITUDES[Math.floor(Math.random() * APTITUDES.length)];
    const safeProtection = Math.max(0, Math.min(10, Math.floor(Number(protectionLevel) || 0)));
    const character = await this.characters.save(
      this.characters.create({
        id: randomUUID(),
        user_id: userId,
        name,
        level: 0,
        crystal_energy: 0,
        aptitude,
        hp: 100,
        max_hp: 100,
        stamina: 100,
        max_stamina: 100,
        speed: 10,
        x: pos.x,
        y: pos.y,
        ship_id: ship.id,
        island_id: null,
        team_id: null,
        protection_level: safeProtection,
        protection_active: safeProtection > 0,
        fatigue: 0,
        fatigued_world_days: 0,
        online_seconds_today: 0,
        status: 'offline',
        title: 'sailor',
        last_seen_at: null,
      }),
    );

    ship.captain_id = character.id;
    await this.ships.save(ship);
    return { character, ship };
  }

  async listByUser(userId: string): Promise<Character[]> {
    return this.characters.find({ where: { user_id: userId }, order: { created_at: 'ASC' } });
  }

  async get(characterId: string): Promise<Character | null> {
    return this.characters.findOne({ where: { id: characterId } });
  }

  async getForUser(userId: string): Promise<Character | null> {
    const list = await this.listByUser(userId);
    return list[0] ?? null;
  }

  async getShip(shipId: string | null): Promise<Ship | null> {
    if (!shipId) return null;
    return this.ships.findOne({ where: { id: shipId } });
  }

  async detail(characterId: string) {
    const character = await this.get(characterId);
    if (!character) return null;
    const [ship, skills] = await Promise.all([
      this.getShip(character.ship_id),
      this.skills.find({ where: { character_id: characterId }, order: { acquired_world_day: 'ASC' } }),
    ]);
    return { character, ship, skills };
  }

  async save(character: Character): Promise<Character> {
    return this.characters.save(character);
  }

  /** 同船人数（用于按实际人数计算移动与物资消耗） */
  async countCrew(shipId: string | null): Promise<number> {
    if (!shipId) return 1;
    const count = await this.characters.count({ where: { ship_id: shipId } });
    return Math.max(1, count);
  }

  async saveShip(ship: Ship): Promise<Ship> {
    return this.ships.save(ship);
  }

  async setStatus(characterId: string, status: string): Promise<void> {
    await this.characters.update({ id: characterId }, { status, last_seen_at: new Date() });
  }

  async recordExperience(
    characterId: string,
    worldDay: number,
    worldMinutes: number,
    eventType: string,
    summary: string,
  ): Promise<void> {
    await this.logs.save(
      this.logs.create({
        id: randomUUID(),
        character_id: characterId,
        world_day: worldDay,
        world_minutes: worldMinutes,
        event_type: eventType,
        summary,
      }),
    );
  }

  /** 技能领悟判定只读最近 2 世界日（§4.2），M1 先提供读取与清理的基础能力 */
  async recentExperience(characterId: string, worldDay: number): Promise<ExperienceLog[]> {
    return this.logs
      .createQueryBuilder('log')
      .where('log.character_id = :characterId', { characterId })
      .andWhere('log.world_day >= :worldDay', { worldDay: worldDay - 2 })
      .orderBy('log.world_day', 'DESC')
      .addOrderBy('log.world_minutes', 'DESC')
      .getMany();
  }
}
