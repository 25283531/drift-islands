import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { INT_TYPE, JSON_TYPE, TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.16 combat_sessions */
@Entity('combat_sessions')
export class CombatSession {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  channel_id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  island_id: string | null;

  /** active / finished */
  @Column({ type: TEXT_TYPE, default: 'active' })
  state: string;

  @Column({ type: INT_TYPE, default: 0 })
  round: number;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  round_deadline: Date | null;

  @Column({ type: JSON_TYPE, nullable: true })
  participants: any;

  @Column({ type: JSON_TYPE, nullable: true })
  actions: any;

  @Column({ type: JSON_TYPE, nullable: true })
  log: any;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}
