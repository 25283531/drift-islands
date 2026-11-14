import { FLEE } from '../game/constants';

/** 战斗数值规则（纯函数，便于单测与数值调校；§4.2） */

/** 玩家逃跑成功率：基础 50%，每比对方快 1 点速度 +5%，封顶 90%，最低 10% */
export function playerFleeChance(playerSpeed: number, fastestMonsterSpeed: number): number {
  const raw = FLEE.PLAYER_BASE + FLEE.PLAYER_SPEED_BONUS * (playerSpeed - fastestMonsterSpeed);
  return Math.min(FLEE.PLAYER_MAX, Math.max(FLEE.PLAYER_MIN, raw));
}

/** 怪物血量 ≤30% 时的逃跑概率：1–3 级 50%，4–6 级 20%，7 级不逃跑 */
export function monsterFleeChance(level: number): number {
  if (level <= 3) return FLEE.MONSTER_LOW_LEVEL;
  if (level <= 6) return FLEE.MONSTER_MID_LEVEL;
  return 0;
}

/** 玩家攻击力：基础 6 + 船火力 + 等级 × 2 */
export function playerAttackPower(level: number, weaponPower: number): number {
  return 6 + weaponPower + level * 2;
}

/** 玩家防御：基础 2 + 防御升级 × 2 */
export function playerDefense(defenseLv: number): number {
  return 2 + defenseLv * 2;
}

export function attackDamage(attack: number, defense: number, defending = false): number {
  const effectiveDefense = defending ? defense * 2 : defense;
  return Math.max(1, attack - effectiveDefense);
}
