import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { FLOAT_TYPE, INT_TYPE, JSON_TYPE, TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.3 ships */
@Entity('ships')
export class Ship {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  captain_id: string | null;

  @Column({ type: TEXT_TYPE, default: '无名船' })
  name: string;

  @Column({ type: INT_TYPE, default: 100 })
  durability: number;

  @Column({ type: INT_TYPE, default: 100 })
  max_durability: number;

  /** 海里 / 世界小时，初始 10 */
  @Column({ type: FLOAT_TYPE, default: 10 })
  speed: number;

  @Column({ type: INT_TYPE, default: 20 })
  cargo_capacity: number;

  @Column({ type: INT_TYPE, default: 0 })
  weapon_power: number;

  @Column({ type: INT_TYPE, default: 0 })
  defense_lv: number;

  @Column({ type: INT_TYPE, default: 0 })
  weapon_lv: number;

  @Column({ type: INT_TYPE, default: 0 })
  living_lv: number;

  @Column({ type: INT_TYPE, default: 0 })
  research_lv: number;

  @Column({ type: FLOAT_TYPE, default: 20 })
  fuel: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  x: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  y: number;

  @Column({ type: INT_TYPE, default: 100 })
  hp: number;

  @Column({ type: INT_TYPE, default: 100 })
  max_hp: number;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** §1.2 characters */
@Entity('characters')
export class Character {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  user_id: string;

  @Column({ type: TEXT_TYPE, unique: true })
  name: string;

  @Column({ type: INT_TYPE, default: 0 })
  level: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  crystal_energy: number;

  /** body / magic / light / dark / element / martial */
  @Column({ type: TEXT_TYPE, default: 'body' })
  aptitude: string;

  @Column({ type: INT_TYPE, default: 100 })
  hp: number;

  @Column({ type: INT_TYPE, default: 100 })
  max_hp: number;

  @Column({ type: INT_TYPE, default: 100 })
  stamina: number;

  @Column({ type: INT_TYPE, default: 100 })
  max_stamina: number;

  @Column({ type: INT_TYPE, default: 10 })
  speed: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  x: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  y: number;

  @Column({ type: TEXT_TYPE, nullable: true })
  ship_id: string | null;

  @Column({ type: TEXT_TYPE, nullable: true })
  island_id: string | null;

  @Column({ type: TEXT_TYPE, nullable: true })
  team_id: string | null;

  @Column({ type: INT_TYPE, default: 0 })
  protection_level: number;

  @Column({ type: 'boolean', default: false })
  protection_active: boolean;

  @Column({ type: FLOAT_TYPE, default: 0 })
  fatigue: number;

  @Column({ type: INT_TYPE, default: 0 })
  fatigued_world_days: number;

  @Column({ type: INT_TYPE, default: 0 })
  online_seconds_today: number;

  /** online / offline / grace / in_combat / dead */
  @Column({ type: TEXT_TYPE, default: 'offline' })
  status: string;

  @Column({ type: TEXT_TYPE, default: 'sailor' })
  title: string;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;

  @Column({ type: TIMESTAMP_TYPE, nullable: true })
  last_seen_at: Date | null;
}

/** §1.11 teams */
@Entity('teams')
export class Team {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  name: string;

  @Column({ type: TEXT_TYPE })
  captain_id: string;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** §1.10 skills */
@Entity('skills')
export class Skill {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  character_id: string;

  @Column({ type: TEXT_TYPE })
  direction: string;

  @Column({ type: TEXT_TYPE })
  name: string;

  @Column({ type: INT_TYPE })
  level_unlocked: number;

  @Column({ type: INT_TYPE })
  acquired_world_day: number;

  @Column({ type: TEXT_TYPE, nullable: true })
  source_summary: string | null;

  @Column({ type: JSON_TYPE, nullable: true })
  payload: any;
}

/** §1.17 experience_logs（滚动 2 世界日） */
@Entity('experience_logs')
export class ExperienceLog {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  character_id: string;

  @Column({ type: INT_TYPE })
  world_day: number;

  @Column({ type: INT_TYPE })
  world_minutes: number;

  @Column({ type: TEXT_TYPE })
  event_type: string;

  @Column({ type: TEXT_TYPE })
  summary: string;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}
