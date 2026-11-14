import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ResourceRegistry } from '../database/entities/world.entities';
import { AiGatewayService } from '../ai/ai-gateway.service';

export type ResourceCategory = 'fuel' | 'food' | 'water' | 'medicine' | 'part' | 'weapon' | 'tech' | 'misc';

export const RESOURCE_CATEGORIES: ResourceCategory[] = [
  'fuel',
  'food',
  'water',
  'medicine',
  'part',
  'weapon',
  'tech',
  'misc',
];

/** 预置别名：相似归一（汽油 / 柴油 → 燃料，§4.2） */
export const BASE_ALIASES: Record<ResourceCategory, string[]> = {
  fuel: ['燃料', '汽油', '柴油', '煤油', '燃油', '油料', 'gasoline', 'diesel', 'fuel', 'petrol'],
  food: ['食物', '罐头', '干粮', '压缩饼干', '腌肉', '米', '面', 'food', 'ration'],
  water: ['水', '淡水', '净水', '饮用水', '矿泉水', 'water'],
  medicine: ['药品', '绷带', '抗生素', '止痛药', '消炎药', '急救包', 'medicine', 'bandage'],
  part: ['零件', '齿轮', '轴承', '螺丝', '电线', '钢板', '管件', 'part', 'gear', 'bolt'],
  weapon: ['武器', '步枪', '手枪', '鱼叉', '砍刀', '弹药', 'weapon', 'rifle', 'ammo'],
  tech: ['科技', '电路板', '电池', '芯片', '传感器', '电台', 'tech', 'circuit', 'battery', 'chip'],
  misc: ['杂项', '布料', '绳子', '木材', 'misc', 'cloth', 'rope'],
};

@Injectable()
export class ResourceRegistryService {
  private readonly logger = new Logger(ResourceRegistryService.name);
  private cache: { at: number; rows: ResourceRegistry[] } | null = null;

  constructor(
    @InjectRepository(ResourceRegistry) private readonly repo: Repository<ResourceRegistry>,
    private readonly ai: AiGatewayService,
  ) {}

  async all(): Promise<ResourceRegistry[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.rows;
    const rows = await this.repo.find();
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  /** 关键词归一到规范类别（不调用模型，纯规则优先） */
  classifyByRules(text: string): ResourceCategory | null {
    const haystack = (text ?? '').toLowerCase();
    if (!haystack.trim()) return null;
    let best: { category: ResourceCategory; hit: string } | null = null;
    for (const category of RESOURCE_CATEGORIES) {
      for (const alias of BASE_ALIASES[category]) {
        if (haystack.includes(alias.toLowerCase()) && (!best || alias.length > best.hit.length)) {
          best = { category, hit: alias };
        }
      }
    }
    return best?.category ?? null;
  }

  /** 规则优先，必要时问模型；模型不可用则归为杂项并登记 */
  async classify(text: string, opts: { useAi?: boolean } = {}): Promise<{ category: ResourceCategory; source: string; canonical: string }> {
    const byRule = this.classifyByRules(text);
    const canonical = (text ?? '').trim().slice(0, 24) || '杂项';
    if (byRule) return { category: byRule, source: 'rule', canonical };

    const rows = await this.all();
    for (const row of rows) {
      const aliases: string[] = Array.isArray(row.aliases) ? row.aliases : [];
      if (row.canonical_name && text?.includes(row.canonical_name)) {
        return { category: row.category as ResourceCategory, source: 'registry', canonical: row.canonical_name };
      }
      if (aliases.some((alias) => alias && text?.includes(alias))) {
        return { category: row.category as ResourceCategory, source: 'registry', canonical: row.canonical_name };
      }
    }

    if (opts.useAi !== false && this.ai.available) {
      try {
        const raw = await this.ai.call(
          'resource_classify',
          `把下面的资源描述归到这些类别之一：${RESOURCE_CATEGORIES.join(', ')}。` +
            `只输出一个类别英文名，不要解释。\n资源描述：${text}`,
          { tier: 'small', temperature: 0, maxTokens: 12 },
        );
        const picked = RESOURCE_CATEGORIES.find((category) => raw.toLowerCase().includes(category));
        if (picked) return { category: picked, source: 'ai', canonical };
      } catch (err) {
        this.logger.warn(`资源归类模型不可用：${(err as Error).message}`);
      }
    }

    await this.ensure(canonical, 'misc');
    return { category: 'misc', source: 'fallback', canonical };
  }

  async ensure(canonicalName: string, category: ResourceCategory): Promise<void> {
    const name = (canonicalName ?? '').trim().slice(0, 24);
    if (!name) return;
    const exists = await this.repo.findOne({ where: { canonical_name: name } });
    if (exists) return;
    await this.repo.save(
      this.repo.create({
        id: randomUUID(),
        canonical_name: name,
        category,
        aliases: [],
        created_at: new Date(),
      }),
    );
    this.cache = null;
  }

  /** 资源方向的展示文本 → 规范类别清单（用于生成岛上资源） */
  async categoriesOf(direction: string): Promise<ResourceCategory[]> {
    const found = new Set<ResourceCategory>();
    for (const category of RESOURCE_CATEGORIES) {
      for (const alias of BASE_ALIASES[category]) {
        if ((direction ?? '').includes(alias)) {
          found.add(category);
          break;
        }
      }
    }
    if (found.size === 0) found.add(await this.classify(direction).then((r) => r.category));
    return [...found];
  }
}
