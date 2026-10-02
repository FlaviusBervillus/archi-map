import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImports, findCycles } from '../js/deps.js';
import { detectLocale, isTranslationCandidate, parseTranslationFile, parseSimpleYaml, normalizeValue, findDuplicates } from '../js/i18n.js';
import { analyzeProject, analyzeTranslationDuplicates, analyzeHardcoded } from '../js/project.js';
import { demoEntries } from '../js/demo.js';

test('extrait les imports JS/TS, CSS, Dart et Python', () => {
  const js = `import a from './a';\nimport { b,\n c } from "@/b";\nexport * from '../c';\nconst d = require('d');\nconst e = await import('./e');\n// import x from './commented';`;
  assert.deepEqual(extractImports(js, 'ts'), ['./a', '@/b', '../c', 'd', './e']);
  assert.deepEqual(extractImports(`@use 'vars';\n@import "./reset.css";`, 'scss'), ['vars', './reset.css']);
  assert.deepEqual(extractImports(`import 'package:app/x.dart';\nimport '../y.dart';`, 'dart'), ['package:app/x.dart', '../y.dart']);
  assert.deepEqual(extractImports(`from .models import User\nimport os, sys`, 'py'), ['py:.models', 'py:os', 'py:sys']);
});

test('détecte les cycles', () => {
  const adj = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']]]);
  assert.deepEqual(findCycles(['a', 'b', 'c', 'd'], adj).map((c) => c.sort()), [['a', 'b', 'c']]);
});

test('reconnaît les fichiers de traduction et leur langue', () => {
  assert.ok(isTranslationCandidate('src/locales/fr.json'));
  assert.ok(isTranslationCandidate('public/i18n/en-US.json'));
  assert.ok(isTranslationCandidate('lib/l10n/app_fr.arb'));
  assert.ok(isTranslationCandidate('app/src/main/res/values-fr/strings.xml'));
  assert.ok(!isTranslationCandidate('package.json'));
  assert.ok(!isTranslationCandidate('src/data/products.json'));
  assert.deepEqual(detectLocale('locales/fr/common.json'), { locale: 'fr', namespace: 'common' });
  assert.deepEqual(detectLocale('i18n/messages.de.yml'), { locale: 'de', namespace: 'messages' });
  assert.deepEqual(detectLocale('lib/l10n/app_pt_BR.arb'), { locale: 'pt-BR', namespace: '' });
  assert.equal(detectLocale('res/values-fr/strings.xml').locale, 'fr');
});

test('parse JSON imbriqué, YAML Rails et ARB', () => {
  const j = parseTranslationFile('locales/fr.json', JSON.stringify({ a: { b: 'Annuler' }, c: 'Email' }));
  assert.deepEqual(j.entries, [{ key: 'a.b', value: 'Annuler' }, { key: 'c', value: 'Email' }]);
  const y = parseTranslationFile('config/locales/fr.yml', 'fr:\n  common:\n    cancel: "Annuler"\n    long: >\n      un texte\n      plié\n');
  assert.equal(y.locale, 'fr');
  assert.deepEqual(y.entries, [{ key: 'common.cancel', value: 'Annuler' }, { key: 'common.long', value: 'un texte plié' }]);
  const arb = parseTranslationFile('l10n/app_fr.arb', JSON.stringify({ '@@locale': 'fr', cancel: 'Annuler', '@cancel': { description: 'x' } }));
  assert.deepEqual(arb.entries, [{ key: 'cancel', value: 'Annuler' }]);
  assert.deepEqual(parseSimpleYaml("a:\n  b: 'l''été'\n  n: 3"), [{ key: 'a.b', value: "l'été" }]);
});

test('normalise les valeurs selon les options', () => {
  assert.equal(normalizeValue('  Email : ', { ignoreCase: true, ignorePunctuation: true }), 'email');
  assert.equal(normalizeValue('E-mail', { ignoreCase: true, loose: true }), 'email');
  assert.equal(normalizeValue('Créer', { ignoreAccents: true }), 'Creer');
});

test('trouve les doublons « Annuler » et propose une clé commune', () => {
  const t = [
    parseTranslationFile('locales/fr.json', JSON.stringify({ login: { cancel: 'Annuler' }, modal: { cancel: 'annuler' }, form: { cancelBtn: 'Annuler' } })),
    parseTranslationFile('locales/en.json', JSON.stringify({ login: { cancel: 'Cancel' }, modal: { cancel: 'Dismiss' }, form: { cancelBtn: 'Cancel' } })),
  ];
  const fr = findDuplicates(t).find((g) => g.locale === 'fr');
  assert.equal(fr.occurrences.length, 3);
  assert.equal(fr.status, 'conflict');
  assert.equal(fr.suggestion.id, 'common.cancel');
});

test('analyse complète du projet de démo', () => {
  const p = analyzeProject(demoEntries());
  assert.deepEqual(p.byPath.get('src/main.tsx').imports, ['src/App.tsx', 'src/i18n.ts', 'src/styles/global.scss']);
  assert.deepEqual(p.insights.cycles.map((c) => c.sort()), [['src/services/api.ts', 'src/services/auth.ts']]);
  assert.ok(p.insights.orphans.includes('src/helpers/format.ts'));
  assert.equal(p.insights.sameNames[0].name, 'format.ts');
  const dups = analyzeTranslationDuplicates(p).filter((g) => g.locale === 'fr');
  assert.equal(dups[0].value, 'Annuler');
  assert.equal(dups[0].occurrences.length, 4);
  const key = p.i18n.translations.find((t) => t.locale === 'fr').entries.find((e) => e.key === 'login.cancel');
  assert.deepEqual(key.usage.files, ['src/pages/LoginPage.tsx']);
  const errors = p.i18n.translations.find((t) => t.locale === 'fr').entries.find((e) => e.key === 'errors.delete');
  assert.equal(errors.usage.status, 'dynamic');
  assert.equal(analyzeHardcoded(p)[0].text, 'Annuler');
  assert.deepEqual(p.i18n.missing, [{ locale: 'en', missing: ['newsletter.subscribe'] }]);
});
