import { describe, expect, it } from 'bun:test';
import { Bot } from 'grammy';
import { registerCallbackDispatcher } from '../src/bot/callbacks/dispatcher.js';

describe('registerCallbackDispatcher', () => {
  it('registers cleanly on a real Bot instance (no throw)', () => {
    const bot = new Bot('test:fake');
    expect(() => registerCallbackDispatcher(bot)).not.toThrow();
  });

  it('registers exactly one callback_query:data handler', () => {
    let callbackHandlerCount = 0;
    const fakeBot: any = {
      on(event: string, _fn: any) {
        if (event === 'callback_query:data') callbackHandlerCount++;
      },
    };
    registerCallbackDispatcher(fakeBot);
    expect(callbackHandlerCount).toBe(1);
  });
});
