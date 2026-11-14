import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { FLOAT_TYPE, INT_TYPE, JSON_TYPE, TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.8 items */
@Entity('items')
export class Item {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  name: string;

  /** fuel / part / weapon / medicine / tech / food / water / misc */
  @Column({ type: TEXT_TYPE, default: 'misc' })
  type: string;

  @Column({ type: JSON_TYPE, nullable: true })
  tags: any;

  @Column({ type: INT_TYPE, default: 1 })
  quantity: number;

  /** good / broken / missing_parts / locked */
  @Column({ type: TEXT_TYPE, nullable: true })
  condition: string | null;

  /** character / ship / island / ground / cache */
  @Column({ type: TEXT_TYPE, default: 'character' })
  owner_type: string;

  @Column({ type: TEXT_TYPE })
  owner_id: string;

  @Column({ type: FLOAT_TYPE, nullable: true })
  x: number | null;

  @Column({ type: FLOAT_TYPE, nullable: true })
  y: number | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** §1.9 crystals */
@Entity('crystals')
export class Crystal {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: INT_TYPE })
  level: number;

  @Column({ type: 'real' })
  energy_total: number;

  @Column({ type: 'real' })
  energy_remaining: number;

  /** character / ground */
  @Column({ type: TEXT_TYPE, default: 'character' })
  holder_type: string;

  @Column({ type: TEXT_TYPE })
  holder_id: string;

  @Column({ type: 'real', nullable: true })
  x: number | null;

  @Column({ type: 'real', nullable: true })
  y: number | null;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}

/** §1.21 dead_drops */
@Entity('dead_drops')
export class DeadDrop {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE })
  placer_character_id: string;

  @Column({ type: 'real' })
  x: number;

  @Column({ type: 'real' })
  y: number;

  @Column({ type: JSON_TYPE, nullable: true })
  item_ids: any;

  @Column({ type: INT_TYPE })
  created_world_day: number;

  @Column({ type: TEXT_TYPE, nullable: true })
  discovered_by: string | null;
}
