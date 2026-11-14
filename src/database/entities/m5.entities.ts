import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** M5 §5.3 内测问题收集（聊天指令「反馈 …」或 API 提交） */
@Entity('feedback')
export class Feedback {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  user_id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  character_id: string | null;

  /** bug / suggestion / balance / other */
  @Column({ type: TEXT_TYPE, default: 'other' })
  category: string;

  @Column({ type: TEXT_TYPE })
  content: string;

  /** new / triaged / closed */
  @Column({ type: TEXT_TYPE, default: 'new' })
  status: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  handled_by: string | null;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  handled_at: Date | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}
