import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Channel, ChatMessage } from '../database/entities/chat.entities';
import { User } from '../database/entities/user.entity';
import { ContentFilterService } from '../ai/content-filter.service';
import { NarratorService } from '../ai/narrator.service';
import { ModerationService } from './moderation.service';
import { GAME } from '../game/constants';

export interface SendResult {
  ok: boolean;
  error?: string;
  message?: ChatMessage;
  quarantined?: boolean;
  warning?: { type: string; text: string };
  moderation?: { action: string; category: string; categoryName: string; count: number };
  aiReply?: string;
}

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    @InjectRepository(ChatMessage) private readonly messages: Repository<ChatMessage>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly moderation: ModerationService,
    private readonly filter: ContentFilterService,
    private readonly narrator: NarratorService,
  ) {}

  async channel(channelId: string): Promise<Channel | null> {
    return this.channels.findOne({ where: { id: channelId } });
  }

  async recent(channelId: string, limit = 50): Promise<ChatMessage[]> {
    const rows = await this.messages.find({
      where: { channel_id: channelId, visibility: 'visible' },
      order: { created_at: 'DESC' },
      take: Math.min(limit, 100),
    });
    return rows.reverse();
  }

  async send(params: {
    characterId: string;
    userId: string;
    channelId: string;
    text: string;
    islandId: string | null;
  }): Promise<SendResult> {
    const text = (params.text ?? '').trim();
    if (!text) return { ok: false, error: '说点什么' };
    if (text.length > 200) return { ok: false, error: '一句话最多 200 个字' };

    const channel = await this.channel(params.channelId);
    if (!channel) return { ok: false, error: '频道不存在' };
    if (channel.type === 'island' && channel.island_id !== params.islandId) {
      return { ok: false, error: '你不在这个岛屿频道里' };
    }

    const user = await this.users.findOne({ where: { id: params.userId } });
    if (!user) return { ok: false, error: '账号不存在' };
    if (user.status === 'banned') return { ok: false, error: '账号已被封禁' };
    if (await this.moderation.isMuted(params.userId)) {
      const remain = await this.moderation.muteRemaining(params.userId);
      return { ok: false, error: `你还在禁言中，约 ${Math.ceil(remain / 60)} 分钟后解除` };
    }

    const classification = this.filter.classify(text);

    // 红线内容：不向其他人展示（隔离），仅发言者可见 + 提示（§4.4）
    if (classification.redline) {
      const message = await this.messages.save(
        this.messages.create({
          id: randomUUID(),
          channel_id: channel.id,
          sender_character_id: params.characterId,
          content: text,
          visibility: 'quarantined',
          moderation_category: classification.redline,
          kind: 'player',
          created_at: new Date(),
        }),
      );
      const outcome = await this.moderation.recordViolation({
        userId: params.userId,
        characterId: params.characterId,
        channelId: channel.id,
        messageId: message.id,
        category: classification.redline,
      });

      let warningText = `这句话触发了内容红线（${outcome.categoryName}），只有你自己能看到。`;
      if (outcome.action === 'mute') {
        warningText += ` 这是第 ${outcome.count} 次违规，你被禁言 1 个世界日。`;
      } else if (outcome.action === 'ban') {
        warningText += ` 这是第 ${outcome.count} 次违规，账号已封禁，等待人工复核。`;
      } else {
        warningText += ' 再犯会被禁言，请换个说法。';
      }

      return {
        ok: true,
        message,
        quarantined: true,
        warning: { type: 'content_violation', text: warningText },
        moderation: {
          action: outcome.action,
          category: outcome.category,
          categoryName: outcome.categoryName,
          count: outcome.count,
        },
      };
    }

    const message = await this.messages.save(
      this.messages.create({
        id: randomUUID(),
        channel_id: channel.id,
        sender_character_id: params.characterId,
        content: text,
        visibility: 'visible',
        moderation_category: null,
        kind: 'player',
        created_at: new Date(),
      }),
    );

    const aiReply = await this.buildAiReply(params.userId, text, classification);
    return { ok: true, message, aiReply };
  }

  /**
   * AI 行为边界（§4.5）：
   * - 闲聊不响应；只回应游戏相关的问题
   * - 医疗建议拒绝；自杀 / 毒品 / 枪支弹药 / 危险品制作方法简短拒绝
   * - 现实制作方法类内容不隔离，言论正常展示，AI 不参与（v1.4）
   */
  async buildAiReply(userId: string, text: string, classification: ReturnType<ContentFilterService['classify']>): Promise<string | undefined> {
    if (classification.boundary === 'self_harm') {
      return '这个话题我不展开。如果你正经历难熬的时刻，请联系当地的心理援助或专业机构，先找人陪着你。';
    }
    if (classification.boundary === 'medical') {
      return '现实里的身体问题我没法给建议，请找专业医生。游戏里的伤，用药品或者回船上养。';
    }
    if (classification.boundary === 'dangerous') {
      return '现实中的制作方法不在游戏的回应范围里，这个话题我不接。';
    }
    if (!classification.gameRelated) return undefined;
    if (!/[?？]|^\/|怎么|如何|为什么|哪里|在哪|什么/.test(text)) return undefined;

    const hint = this.templateHint(text);
    const result = await this.narrator.render('ai_chat', { text: hint }, { userId, tier: 'small' });
    return result.text;
  }

  private templateHint(text: string): string {
    if (/岛/.test(text)) return '往洋流指的方向走。连着航行两个世界小时还看不到岛，洋流会把你送过去。';
    if (/怪物|战斗|攻击|打/.test(text)) return '怪物血少了会跑，别追进废墟。一个回合十五秒，超时不动就算防守。';
    if (/燃料|油/.test(text)) return '顺着洋流走不烧油，逆流每世界小时烧一单位。油箱空了，船就只能走一半的路。';
    if (/晶核|升级/.test(text)) return '晶核得吸收才算数。越级吸收只能拿走一部分，剩下的还留在晶体里。';
    if (/规则|频道|世界/.test(text)) return '一个世界日八个现实小时，白天十六世界时、夜里八世界时。夜里看不远，遭遇距离会缩短。';
    return '海面没有立刻回答，只有浪拍船壳的声音。';
  }

  async systemMessage(channelId: string, text: string): Promise<ChatMessage> {
    return this.messages.save(
      this.messages.create({
        id: randomUUID(),
        channel_id: channelId,
        sender_character_id: null,
        content: text,
        visibility: 'visible',
        moderation_category: null,
        kind: 'system',
        created_at: new Date(),
      }),
    );
  }

  /** AI 回话（kind=ai），与玩家发言一起入库，便于复盘 */
  async aiMessage(channelId: string, text: string): Promise<ChatMessage> {
    return this.messages.save(
      this.messages.create({
        id: randomUUID(),
        channel_id: channelId,
        sender_character_id: null,
        content: text,
        visibility: 'visible',
        moderation_category: null,
        kind: 'ai',
        created_at: new Date(),
      }),
    );
  }

  /** 世界日 / 时辰播报（系统消息，不参与 AI 配额） */
  async worldNotice(channelId: string, text: string): Promise<void> {
    await this.systemMessage(channelId, text);
  }

  /** 供配额测试与前端展示：当前频道消息数（不对外暴露分页细节） */
  async count(channelId: string): Promise<number> {
    return this.messages.count({ where: { channel_id: channelId } });
  }

  static readonly MAX_LENGTH = 200;
  static readonly WORLD_DAY_MINUTES = GAME.WORLD_MINUTES_PER_DAY;
}
