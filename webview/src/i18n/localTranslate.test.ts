import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';
import zhTW from './locales/zh-TW.json';

const LOCALES: Record<string, Record<string, unknown>> = {
  en, zh, 'zh-TW': zhTW, hi, es, fr, ja, ru, ko, 'pt-BR': ptBR,
};

const KEYS = [
  'tooltip',
  'shortcutCmdEnterMac',
  'shortcutCmdEnter',
  'shortcutShiftEnter',
  'failed',
  'unreachable',
  'timeout',
  'httpError',
  'invalidResponse',
  'disabled',
  'placeholderMismatch',
  'draftChanged',
  'replyShow',
  'replyHide',
  'replyAllShow',
  'replyAllHide',
  'cacheUnreadable',
];

describe('localTranslate locale keys', () => {
  it.each(Object.keys(LOCALES))('%s has every localTranslate key', (locale) => {
    const section = LOCALES[locale].localTranslate as Record<string, unknown> | undefined;
    expect(section).toBeDefined();
    for (const key of KEYS) {
      expect(typeof section?.[key], `${locale}.localTranslate.${key}`).toBe('string');
      expect((section?.[key] as string).length).toBeGreaterThan(0);
    }
    expect(section?.httpError).toContain('{{status}}');
  });

  it('leaves the enhancer shortcut unchanged', () => {
    expect((en.promptEnhancer as Record<string, string>).shortcut).toBe('⌘/');
  });

  it.each(Object.keys(LOCALES).filter((l) => l !== 'en'))('%s localizes reply translation strings instead of leaving English text', (locale) => {
    const section = LOCALES[locale].localTranslate as Record<string, string>;
    const enSection = en.localTranslate as Record<string, string>;
    for (const key of ['tooltip', 'replyShow', 'replyAllShow', 'replyAllHide', 'cacheUnreadable']) {
      expect(section[key], `${locale}.localTranslate.${key}`).not.toBe(enSection[key]);
    }
  });
});
