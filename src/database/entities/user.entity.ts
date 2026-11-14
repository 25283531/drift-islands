import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { TEXT_TYPE, TIMESTAMP_TYPE } from '../column-types';

/** §1.1 users：账号 */
@Entity('users')
export class User {
  @PrimaryColumn({ type: TEXT_TYPE })
  id: string;

  @Column({ type: TEXT_TYPE, unique: true })
  display_name: string;

  /** normal / muted / banned (§4.4) */
  @Column({ type: TEXT_TYPE, default: 'normal' })
  status: string;

  @CreateDateColumn({ type: TIMESTAMP_TYPE })
  created_at: Date;
}
