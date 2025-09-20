import z from 'zod';
import { nanoid } from 'nanoid';

export const schema = {
  add: {
    description: 'adds two numbers',
    input: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  get_id: { description: 'returns a random nanoid' },
  get_var14: { description: 'return var' },
};

export function add({ a, b } = params) {
  return String(a + b + 10);
}
export function get_id() {
  return nanoid();
}
export function get_var14() {
  return process.env.var1;
}
