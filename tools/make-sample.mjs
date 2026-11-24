// Writes samples/Sample.tonote, a test document with every note type.
// Encrypted notes use the password "sample".   Run: node tools/make-sample.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const PASSWORD = 'sample';
const b64 = (u8) => Buffer.from(u8).toString('base64');
const salt = crypto.getRandomValues(new Uint8Array(16));
const iterations = 210000;
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
async function enc(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
}
const verifier = await enc('tonote-vault-verifier-v1');

const now = new Date().toISOString();
let order = 0;
const note = (id, parentId, title, type, content = '', isEncrypted = false) =>
  ({ id, parentId, title, type, content, isEncrypted, sortOrder: (order += 1024), createdAt: now, updatedAt: now });

const todo = [
  '<!-- tonote:todo meta v1 sortMode="priority" -->',
  '',
  '- [ ] Renew passport <!-- tonote:item id="t1" priority="high" -->',
  '  - <!-- tonote:note id="tn1" --> Form DS-82, see https://travel.state.gov',
  '    Bring two photos',
  '- [ ] Buy **milk** and eggs <!-- tonote:item id="t2" priority="none" -->',
  '- [ ] Call the dentist <!-- tonote:item id="t3" priority="medium" -->',
  '- [ ] Clean gutters <!-- tonote:item id="t4" priority="low" -->',
  '- [x] File taxes <!-- tonote:item id="t5" priority="high" completedAt="2026-04-10T12:00:00.000Z" -->',
].join('\n');

const passwords = JSON.stringify({ entries: [
  { id: 'p2', name: 'Netflix', username: 'me@example.com', password: 'hunter2-netflix', note: '' },
  { id: 'p1', name: 'Bank', username: 'jdoe', password: 'c0rrect-h0rse', note: 'Login at https://bank.example.com\nPIN hint: birthday' },
  { id: 'p3', name: 'wifi', username: '', password: 'HomeWifi2026!', note: 'Guest network: HomeGuest' },
] }, null, 2);

const markdown = `# Welcome

This is a **markdown** note with *formatting*, \`inline code\` and a [link](https://example.com).

## A list

- First item
- Second item
  - Nested item
- [ ] An unchecked task
- [x] A checked task

## A table

| Fruit | Color | Notes |
| --- | --- | --- |
| Apple | Red | Crunchy |
| Banana | Yellow | Long text in a cell that keeps going so the table needs to wrap on a phone |

> A quote block.

\`\`\`js
console.log('code block');
\`\`\`
`;

const notes = [
  note('f1', null, 'Personal', 'folder'),
  note('m1', 'f1', 'Welcome', 'markdown', markdown),
  note('t1', 'f1', 'To do', 'todo', todo),
  note('f2', 'f1', 'Trips', 'folder'),
  note('m2', 'f2', 'Japan 2027', 'markdown', 'Flights booked.\n\n1. Tokyo\n2. Kyoto\n3. Osaka'),
  note('p1', null, 'Passwords', 'password-grid', JSON.stringify(await enc(passwords)), true),
  note('m3', null, 'Secret diary', 'markdown', JSON.stringify(await enc('# Dear diary\n\nThis note is **encrypted**.')), true),
  note('m4', null, 'Empty note', 'markdown', ''),
  note('m5', null, 'A note with a very long title that should be truncated in the tree view', 'markdown', 'Short body.'),
];

const doc = { formatVersion: 1, vault: { salt: b64(salt), kdfIterations: iterations, verifierIv: verifier.iv, verifierCiphertext: verifier.ciphertext }, notes };
mkdirSync(new URL('../samples/', import.meta.url), { recursive: true });
writeFileSync(new URL('../samples/Sample.tonote', import.meta.url), JSON.stringify(doc, null, 2));
console.log('Wrote samples/Sample.tonote (password: sample)');
