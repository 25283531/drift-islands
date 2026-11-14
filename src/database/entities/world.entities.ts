import { Column, Entity, PrimaryColumn } from 'typeorm';
import { DATE_TYPE, FLOAT_TYPE, INT_TYPE, JSON_TYPE, TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.14 world_state（单行，id 固定 1） */
@Entity('world_state')
export class WorldState {
  @PrimaryColumn({ type: INT_TYPE })
  id: number;

  @Column({ type: INT_TYPE, default: 1 })
  world_day: number;

  @Column({ type: INT_TYPE, default: 360 })
  world_minutes: number;

  @Column({ type: FLOAT_TYPE, default: 50 })
  sea_radius_nm: number;

  @Column({ type: INT_TYPE, default: 0 })
  island_count: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  current_direction: number;

  @Column({ type: TIMESTAMP_TYPE })
  last_tick_at: Date;
}

/** §1.15 world_events */
@Entity('world_events')
export class WorldEvent {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  /** world_day / real_time */
  @Column({ type: TEXT_TYPE })
  trigger_type: string;

  @Column({ type: TEXT_TYPE })
  trigger_value: string;

  @Column({ type: TEXT_TYPE })
  event_type: string;

  @Column({ type: JSON_TYPE, nullable: true })
  payload: any;

  /** pending / active / done */
  @Column({ type: TEXT_TYPE, default: 'pending' })
  status: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  created_by: string | null;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  created_at: Date | null;
}

/** §1.20 resource_registry */
@Entity('resource_registry')
export class ResourceRegistry {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE, unique: true })
  canonical_name: string;

  @Column({ type: JSON_TYPE, nullable: true })
  aliases: any;

  @Column({ type: TEXT_TYPE })
  category: string;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  created_at: Date | null;
}

/** §1.19 model_pool */
@Entity('model_pool')
export class ModelPool {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  /** large / small */
  @Column({ type: TEXT_TYPE })
  tier: string;

  @Column({ type: TEXT_TYPE })
  model_id: string;

  @Column({ type: INT_TYPE, default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: INT_TYPE, default: 0 })
  failure_count: number;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  last_failure_at: Date | null;
}

/** §1.22 ai_quotas */
@Entity('ai_quotas')
export class AiQuota {
  @PrimaryColumn({ type: TEXT_TYPE })
  user_id: string;

  @PrimaryColumn({ type: DATE_TYPE })
  real_date: string;

  @Column({ type: INT_TYPE, default: 0 })
  calls_used: number;

  @Column({ type: INT_TYPE, default: 200 })
  budget: number;

  @Column({ type: 'boolean', default: false })
  degraded: boolean;
}
