import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { FLOAT_TYPE, INT_TYPE, TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** M4 §4.1 岛屿评价（每人每岛一条，可改） */
@Entity('island_ratings')
export class IslandRating {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  island_id: string;

  @Column({ type: TEXT_TYPE })
  user_id: string;

  @Column({ type: INT_TYPE })
  score: number;

  @Column({ type: TEXT_TYPE, nullable: true })
  comment: string | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** M4 §4.2 创作者激励发放台账（可审计，按岛+周期幂等） */
@Entity('creator_rewards')
export class CreatorReward {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  island_id: string;

  @Column({ type: TEXT_TYPE })
  creator_user_id: string;

  @Column({ type: INT_TYPE })
  period_day: number;

  @Column({ type: FLOAT_TYPE })
  score: number;

  @Column({ type: INT_TYPE })
  amount: number;

  @Column({ type: TEXT_TYPE })
  reason: string;

  /** granted（已发放）/ void（撤销） */
  @Column({ type: TEXT_TYPE, default: 'granted' })
  status: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  settled_by: string | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** M4 §4.3 举报 */
@Entity('reports')
export class Report {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  reporter_user_id: string;

  /** chat_message / island / character */
  @Column({ type: TEXT_TYPE })
  target_type: string;

  @Column({ type: TEXT_TYPE })
  target_id: string;

  @Column({ type: TEXT_TYPE })
  category: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  detail: string | null;

  /** pending / resolved / dismissed */
  @Column({ type: TEXT_TYPE, default: 'pending' })
  status: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  action: string | null;

  @Column({ type: TEXT_TYPE, nullable: true })
  handled_by: string | null;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  handled_at: Date | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}
