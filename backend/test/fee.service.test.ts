import { FeeService } from '@parking/core';
import { describe, expect, it } from 'vitest';
import { makeMockFeeRepo } from './helpers/mockFee.js';

/** FeeService.get の分岐（404 / pending 合成 / confirmed）を検証する。 */
describe('FeeService.get', () => {
  it('他人/不在 → 404 not_found', async () => {
    const repo = makeMockFeeRepo({ exists: false });
    await expect(new FeeService(repo).get('u1', 'r1')).rejects.toMatchObject({
      httpStatus: 404,
      code: 'not_found',
    });
  });

  it('Fee 未記録 → pending をゼロ額で合成', async () => {
    const repo = makeMockFeeRepo({ exists: true, fee: null });
    const res = await new FeeService(repo).get('u1', 'r1');
    expect(res).toEqual({
      reservation_id: 'r1',
      slot_fee: 0,
      overstay_fee: 0,
      total: 0,
      status: 'pending',
      calculated_at: null,
    });
  });

  it('Fee あり → confirmed をそのまま返す（calculated_at は ISO）', async () => {
    const repo = makeMockFeeRepo({
      exists: true,
      fee: {
        reservation_id: 'r1',
        slot_fee: 200,
        overstay_fee: 100,
        total: 300,
        status: 'confirmed',
        calculated_at: new Date('2026-06-25T12:00:00Z'),
      },
    });
    const res = await new FeeService(repo).get('u1', 'r1');
    expect(res).toMatchObject({ status: 'confirmed', total: 300 });
    expect(res.calculated_at).toBe('2026-06-25T12:00:00.000Z');
  });
});
