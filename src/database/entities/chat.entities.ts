import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.12 channels */
@Entity('channels')
export class Channel {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  /** sea（公共海频道）/ island（岛屿子频道） */
  @Column({ type: TEXT_TYPE })
  type: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  island_id: string | null;

  @Column({ type: TEXT_TYPE })
  name: string;
}

/** §1.13 chat_messages */
@Entity('chat_messages')
export class ChatMessage {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  channel_id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  sender_character_id: string | null;

  @Column({ type: TEXT_TYPE })
  content: string;

  /** visible / quarantined（红线内容仅发言者本人可见） */
  @Column({ type: TEXT_TYPE, default: 'visible' })
  visibility: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  moderation_category: string | null;

  /** 非 M0 字段：区分玩家发言与系统 / AI 叙述，便于前端展示 */
  @Column({ type: TEXT_TYPE, default: 'player' })
  kind: string;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** §1.18 moderation_records */
@Entity('moderation_records')
export class ModerationRecord {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  user_id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  character_id: string | null;

  @Column({ type: TEXT_TYPE, nullable: true })
  channel_id: string | null;

  @Column({ type: TEXT_TYPE, nullable: true })
  message_id: string | null;

  @Column({ type: TEXT_TYPE })
  category: string;

  /** warn / quarantine / mute / ban */
  @Column({ type: TEXT_TYPE })
  action: string;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;

  @Column({ type: TEXT_TYPE, nullable: true })
  reviewed_by: string | null;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  reviewed_at: Date | null;
}
