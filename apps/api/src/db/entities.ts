/**
 * TypeORM entities of the master tables (doc 02 §3), used only by the admin CRUD (doc 03 §5.1). They map the
 * tables the SQL migrations create; TypeORM never changes the schema (`synchronize` is off). Property names are the
 * admin API's field names, so a row leaves the API as it is read. `created_at` is left to its column default and
 * `updated_at` is set by TypeORM on every update.
 */
import type { AreaId, Classification, DefectId, PsiLevel } from '@m100/shared';
import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('psi_users')
export class PsiUserEntity {
  @PrimaryGeneratedColumn('identity', { generatedIdentity: 'ALWAYS' })
  id!: number;

  @Column('text')
  username!: string;

  @Column('text')
  level!: PsiLevel;

  @Column('boolean')
  active!: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', select: false })
  updatedAt?: Date;
}

@Entity('factories')
export class FactoryEntity {
  @PrimaryGeneratedColumn('identity', { generatedIdentity: 'ALWAYS' })
  id!: number;

  @Column('text')
  name!: string;

  @Column('boolean')
  active!: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', select: false })
  updatedAt?: Date;
}

@Entity('cells')
export class CellEntity {
  @PrimaryGeneratedColumn('identity', { generatedIdentity: 'ALWAYS' })
  id!: number;

  @Column('integer', { name: 'factory_id' })
  factoryId!: number;

  @Column('text')
  code!: string;

  @Column('boolean')
  active!: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', select: false })
  updatedAt?: Date;
}

@Entity('pos')
export class PoEntity {
  @PrimaryColumn('text')
  po!: string;

  @Column('text')
  article!: string;

  @Column('text')
  model!: string;

  @Column('text')
  destination!: string;

  @Column('integer', { name: 'order_qty' })
  orderQty!: number;

  /** `YYYY-MM-DD` or null. */
  @Column('date', { nullable: true })
  podd!: string | null;

  @Column('date', { nullable: true })
  crd!: string | null;

  @Column('boolean', { nullable: true })
  finished!: boolean | null;

  @Column('boolean')
  active!: boolean;

  /** `import:<file>` or `admin`. */
  @Column('text')
  source!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', select: false })
  updatedAt?: Date;
}

@Entity('defects')
export class DefectEntity {
  @PrimaryColumn('text')
  id!: DefectId;

  @Column('text')
  name!: string;

  @Column('text', { name: 'severity' })
  classification!: Classification;

  @Column('text', { name: 'ctq_category', nullable: true })
  ctqCategory!: string | null;

  @Column('text', { name: 'ctq_code', nullable: true })
  ctqCode!: string | null;

  @Column('boolean')
  active!: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', select: false })
  updatedAt?: Date;
}

@Entity('areas')
export class AreaEntity {
  @PrimaryColumn('text')
  id!: AreaId;

  @Column('text')
  name!: string;

  @Column('integer')
  sort!: number;

  @Column('boolean')
  active!: boolean;
}

@Entity('sub_areas')
export class SubAreaEntity {
  @PrimaryColumn('text')
  id!: string;

  @Column('text', { name: 'area_id' })
  areaId!: AreaId;

  @Column('text')
  name!: string;

  @Column('integer')
  sort!: number;

  @Column('boolean')
  active!: boolean;
}

@Entity('families')
export class FamilyEntity {
  @PrimaryColumn('text')
  id!: string;

  @Column('text')
  name!: string;

  @Column('boolean')
  active!: boolean;
}

@Entity('area_map')
export class AreaMapEntity {
  @PrimaryColumn('text')
  id!: string;

  @Column('text', { name: 'area_id' })
  areaId!: AreaId;

  @Column('text', { name: 'sub_area_id' })
  subAreaId!: string;

  @Column('text', { name: 'family_id' })
  familyId!: string;

  @Column('text', { name: 'defect_id' })
  defectId!: DefectId;

  @Column('boolean')
  active!: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', select: false })
  updatedAt?: Date;
}

export const ADMIN_ENTITIES = [
  PsiUserEntity,
  FactoryEntity,
  CellEntity,
  PoEntity,
  DefectEntity,
  AreaEntity,
  SubAreaEntity,
  FamilyEntity,
  AreaMapEntity,
];
