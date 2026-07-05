import { describe, it, expectTypeOf } from 'vitest';
import type { EmbedRequest, EmbedResponse, StatusResponse } from '../src/api';

describe('embed api types', () => {
  it('shapes compile', () => {
    expectTypeOf<EmbedRequest>().toHaveProperty('texts');
    expectTypeOf<EmbedResponse>().toHaveProperty('vectors');
    expectTypeOf<StatusResponse>().toHaveProperty('embed');
  });
});
