import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { FLOAT_TYPE, INT_TYPE, JSON_TYPE, TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.4 islands */
@Entity('islands')
export class Island {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  creator_user_id: string | null;

  @Column({ type: TEXT_TYPE })
  name: string;

  @Column({ type: FLOAT_TYPE })
  x: number;

  @Column({ type: FLOAT_TYPE })
  y: number;

  @Column({ type: FLOAT_TYPE, default: 5 })
  radius: number;

  @Column({ type: JSON_TYPE, nullable: true })
  rules: any;

  @Column({ type: TEXT_TYPE, nullable: true })
  resource_direction: string | null;

  @Column({ type: JSON_TYPE, nullable: true })
  buildings: any;

  @Column({ type: JSON_TYPE, nullable: true })
  defenses: any;

  @Column({ type: JSON_TYPE, nullable: true })
  monster_config: any;

  @Column({ type: FLOAT_TYPE, default: 60 })
  threat_budget: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  threat_used: number;

  @Column({ type: INT_TYPE, default: 0 })
  max_monster_level: number;

  @Column({ type: INT_TYPE, default: 0 })
  visit_count: number;

  @Column({ type: INT_TYPE, default: 0 })
  resources_taken: number;

  @Column({ type: TEXT_TYPE, nullable: true })
  owner_character_id: string | null;

  @Column({ type: INT_TYPE, default: 1 })
  created_world_day: number;

  @Column({ type: INT_TYPE, default: 1 })
  last_visit_world_day: number;

  /** active（岛屿永久存在，不沉没） */
  @Column({ type: TEXT_TYPE, default: 'active' })
  status: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  description: string | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** §1.5 island_points */
@Entity('island_points')
export class IslandPoint {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  island_id: string;

  @Column({ type: TEXT_TYPE })
  name: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  description: string | null;

  @Column({ type: JSON_TYPE, nullable: true })
  monster_kind_ids: any;

  @Column({ type: INT_TYPE, default: 0 })
  monster_count: number;
}

/** §1.6 monster_kinds */
@Entity('monster_kinds')
export class MonsterKind {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  name: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  description: string | null;

  @Column({ type: INT_TYPE, default: 10 })
  base_hp: number;

  @Column({ type: INT_TYPE, default: 5 })
  base_speed: number;

  @Column({ type: INT_TYPE, default: 3 })
  base_attack: number;

  @Column({ type: JSON_TYPE, nullable: true })
  skill_pool: any;

  @Column({ type: INT_TYPE, default: 1 })
  min_world_day: number;

  @Column({ type: INT_TYPE, default: 1 })
  max_level: number;
}

/** §1.7 monsters */
@Entity('monsters')
export class Monster {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  kind_id: string | null;

  @Column({ type: TEXT_TYPE, nullable: true })
  custom_name: string | null;

  @Column({ type: JSON_TYPE, nullable: true })
  custom_stats: any;

  @Column({ type: TEXT_TYPE, nullable: true })
  island_id: string | null;

  @Column({ type: INT_TYPE, default: 0 })
  level: number;

  @Column({ type: INT_TYPE, default: 10 })
  hp: number;

  @Column({ type: INT_TYPE, default: 10 })
  max_hp: number;

  @Column({ type: INT_TYPE, default: 5 })
  speed: number;

  @Column({ type: INT_TYPE, default: 3 })
  attack: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  x: number;

  @Column({ type: FLOAT_TYPE, default: 0 })
  y: number;

  /** idle / patrol / chase / combat / negotiate / dead */
  @Column({ type: TEXT_TYPE, default: 'idle' })
  state: string;

  @Column({ type: TEXT_TYPE, nullable: true })
  faction_id: string | null;

  @Column({ type: JSON_TYPE, nullable: true })
  skills: any;

  @Column({ type: INT_TYPE, default: 1 })
  created_world_day: number;
}
