import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from './entities/chat.entities';
import { Island, Monster, MonsterKind } from './entities/island.entities';
import { ModelPool, ResourceRegistry, WorldState } from './entities/world.entities';
import { GAME } from '../game/constants';
import { envStr } from '../common/env';

export const FIXED_IDS = {
  SEA_CHANNEL: '00000000-0000-4000-8000-000000000001',
  PRESET_ISLAND: '00000000-0000-4000-8000-000000000101',
  PRESET_ISLAND_CHANNEL: '00000000-0000-4000-8000-000000000102',
  KIND_DROWNED: '00000000-0000-4000-8000-000000000201',
  KIND_SCAVENGER: '00000000-0000-4000-8000-000000000202',
  KIND_BARNACLE: '00000000-0000-4000-8000-000000000203',
  KIND_HUNTER: '00000000-0000-4000-8000-000000000204',
  MONSTER_A: '00000000-0000-4000-8000-000000000301',
  MONSTER_B: '00000000-0000-4000-8000-000000000302',
  MONSTER_C: '00000000-0000-4000-8000-000000000303',
} as const;

/**
 * 种子数据（M1 单岛预置）。
 * 幂等：全部按固定 ID upsert，重复启动不会重复建岛。
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(WorldState) private readonly world: Repository<WorldState>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    @InjectRepository(Island) private readonly islands: Repository<Island>,
    @InjectRepository(MonsterKind) private readonly kinds: Repository<MonsterKind>,
    @InjectRepository(Monster) private readonly monsters: Repository<Monster>,
    @InjectRepository(ResourceRegistry) private readonly resources: Repository<ResourceRegistry>,
    @InjectRepository(ModelPool) private readonly modelPool: Repository<ModelPool>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSeed();
  }

  async ensureSeed(): Promise<void> {
    await this.ensureWorld();
    await this.ensureSeaChannel();
    await this.ensureMonsterKinds();
    await this.ensurePresetIsland();
    await this.ensurePresetMonsters();
    await this.ensureResources();
    await this.ensureModelPool();
    const islandCount = await this.islands.count();
    const state = await this.world.findOne({ where: { id: 1 } });
    if (state && state.island_count !== islandCount) {
      state.island_count = islandCount;
      await this.world.save(state);
    }
  }

  private async ensureWorld(): Promise<void> {
    const existing = await this.world.findOne({ where: { id: 1 } });
    if (existing) return;
    await this.world.save(
      this.world.create({
        id: 1,
        world_day: 1,
        // 06:00 开局，处于白天（白天 0–959 世界分钟）
        world_minutes: 360,
        sea_radius_nm: GAME.INITIAL_SEA_RADIUS_NM,
        island_count: 0,
        current_direction: 45,
        last_tick_at: new Date(),
      }),
    );
    this.logger.log('世界时钟初始化：世界日 1 · 06:00');
  }

  private async ensureSeaChannel(): Promise<void> {
    const existing = await this.channels.findOne({ where: { id: FIXED_IDS.SEA_CHANNEL } });
    if (existing) return;
    await this.channels.save(
      this.channels.create({
        id: FIXED_IDS.SEA_CHANNEL,
        type: 'sea',
        island_id: null,
        name: '公共海频道',
      }),
    );
  }

  private async ensureMonsterKinds(): Promise<void> {
    const kinds: Partial<MonsterKind>[] = [
      {
        id: FIXED_IDS.KIND_DROWNED,
        name: '溺尸',
        description: '泡烂的水手尸体，动作迟缓，本能地扑向活人。',
        base_hp: 16,
        base_speed: 4,
        base_attack: 4,
        skill_pool: [],
        min_world_day: 1,
        max_level: 1,
      },
      {
        id: FIXED_IDS.KIND_SCAVENGER,
        name: '拾荒者',
        description: '在废墟里翻找物资的幸存者，会用锈刀，懂得躲避。',
        base_hp: 28,
        base_speed: 7,
        base_attack: 6,
        skill_pool: ['乱挥'],
        min_world_day: 1,
        max_level: 3,
      },
      {
        id: FIXED_IDS.KIND_BARNACLE,
        name: '藤壶蟹',
        description: '壳上长满藤壶的巨型蟹，钳击沉重，夜里更难发现。',
        base_hp: 40,
        base_speed: 3,
        base_attack: 9,
        skill_pool: ['钳击'],
        min_world_day: 1,
        max_level: 2,
      },
      {
        id: FIXED_IDS.KIND_HUNTER,
        name: '深海猎手',
        description: '从深水里爬上来的东西，7 级个体拥有完整智慧。',
        base_hp: 70,
        base_speed: 9,
        base_attack: 14,
        skill_pool: ['突袭', '设陷阱', '谈判'],
        min_world_day: 3,
        max_level: 7,
      },
    ];
    for (const kind of kinds) {
      const exists = await this.kinds.findOne({ where: { id: kind.id } });
      if (!exists) await this.kinds.save(this.kinds.create(kind));
    }
  }

  private async ensurePresetIsland(): Promise<void> {
    const existing = await this.islands.findOne({ where: { id: FIXED_IDS.PRESET_ISLAND } });
    if (existing) {
      // 岛屿子频道可能缺失（旧数据 / 手工删表）
      const channel = await this.channels.findOne({ where: { id: FIXED_IDS.PRESET_ISLAND_CHANNEL } });
      if (!channel) await this.createIslandChannel();
      return;
    }

    await this.islands.save(
      this.islands.create({
        id: FIXED_IDS.PRESET_ISLAND,
        creator_user_id: null,
        name: '锈锚岛',
        x: 12,
        y: 8,
        radius: 8,
        rules: [
          '岛上由拾荒者与藤壶蟹控制，进入者会被攻击。',
          '修船厂的油罐还能抽出燃料，但动静会引来更多怪物。',
          '禁止在岛上放火，火会烧掉还能用的零件。',
        ],
        resource_direction: '废弃修船厂：燃料、零件、少量药品',
        buildings: ['塌掉的船坞', '半沉的油罐', '生锈的吊车'],
        defenses: [{ name: '铁丝网', level: 1 }],
        monster_config: {
          kinds: [FIXED_IDS.KIND_DROWNED, FIXED_IDS.KIND_SCAVENGER, FIXED_IDS.KIND_BARNACLE],
          max_level: 2,
          count: 3,
          concentrated: true,
          point: '干船坞',
        },
        threat_budget: 60,
        threat_used: 5,
        max_monster_level: 2,
        visit_count: 0,
        resources_taken: 0,
        owner_character_id: null,
        created_world_day: 1,
        last_visit_world_day: 1,
        status: 'active',
        description: '一座半沉的修船厂，锈味混着柴油味。吊车歪在浅滩上，干船坞里还有东西在动。',
      }),
    );
    await this.createIslandChannel();
    this.logger.log('预置岛屿已生成：锈锚岛（12, 8）半径 8 海里');
  }

  private async createIslandChannel(): Promise<void> {
    await this.channels.save(
      this.channels.create({
        id: FIXED_IDS.PRESET_ISLAND_CHANNEL,
        type: 'island',
        island_id: FIXED_IDS.PRESET_ISLAND,
        name: '锈锚岛',
      }),
    );
  }

  private async ensurePresetMonsters(): Promise<void> {
    const existing = await this.monsters.count({ where: { island_id: FIXED_IDS.PRESET_ISLAND } });
    if (existing > 0) return;
    const preset = [
      { id: FIXED_IDS.MONSTER_A, kind: FIXED_IDS.KIND_DROWNED, name: '溺尸', level: 0, hp: 16, speed: 4, attack: 4 },
      { id: FIXED_IDS.MONSTER_B, kind: FIXED_IDS.KIND_SCAVENGER, name: '拾荒者', level: 1, hp: 30, speed: 7, attack: 6 },
      { id: FIXED_IDS.MONSTER_C, kind: FIXED_IDS.KIND_BARNACLE, name: '藤壶蟹', level: 2, hp: 55, speed: 3, attack: 11 },
    ];
    for (const m of preset) {
      await this.monsters.save(
        this.monsters.create({
          id: m.id,
          kind_id: m.kind,
          custom_name: null,
          custom_stats: null,
          island_id: FIXED_IDS.PRESET_ISLAND,
          level: m.level,
          hp: m.hp,
          max_hp: m.hp,
          speed: m.speed,
          attack: m.attack,
          x: 12,
          y: 8,
          state: 'idle',
          faction_id: null,
          skills: [],
          created_world_day: 1,
        }),
      );
    }
  }

  private async ensureResources(): Promise<void> {
    const rows = [
      { canonical_name: '燃料', category: 'fuel', aliases: ['汽油', '柴油', '燃油', '油'] },
      { canonical_name: '食物', category: 'food', aliases: ['罐头', '干粮', '口粮', '吃的'] },
      { canonical_name: '淡水', category: 'water', aliases: ['水', '饮用水', '净水'] },
      { canonical_name: '零件', category: 'part', aliases: ['螺丝', '轴承', '配件', '可用零件'] },
      { canonical_name: '药品', category: 'medicine', aliases: ['药', '消炎药', '止痛药', '绷带'] },
      { canonical_name: '科技件', category: 'tech', aliases: ['电路板', '芯片', '仪器', '科技零件'] },
    ];
    for (let i = 0; i < rows.length; i += 1) {
      const id = `00000000-0000-4000-8000-0000000004${String(i + 1).padStart(2, '0')}`;
      const exists = await this.resources.findOne({ where: { canonical_name: rows[i].canonical_name } });
      if (!exists) {
        await this.resources.save(this.resources.create({ id, ...rows[i] }));
      }
    }
  }

  private async ensureModelPool(): Promise<void> {
    const small = envStr('AI_MODEL_SMALL');
    const large = envStr('AI_MODEL_LARGE');
    if (!small && !large) return;
    const rows = [
      { id: '00000000-0000-4000-8000-000000000501', tier: 'small', model_id: small || large },
      { id: '00000000-0000-4000-8000-000000000502', tier: 'large', model_id: large || small },
    ];
    for (const row of rows) {
      if (!row.model_id) continue;
      const exists = await this.modelPool.findOne({ where: { id: row.id } });
      if (!exists) {
        await this.modelPool.save(
          this.modelPool.create({ ...row, priority: 10, enabled: true, failure_count: 0, last_failure_at: null }),
        );
      }
    }
  }
}
