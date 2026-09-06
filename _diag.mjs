import { Session } from './src/session.mjs'
const s = await Session.open('gemini')
const prompts = [
  ['code', 'Write a Python function that computes a pooled odds ratio by the Mantel-Haenszel method. Code only.'],
  ['file', 'Build a CSV file with 5 rows of paediatric anaesthesia trial data, columns pmid,drug,n,effect. Give me the actual file.'],
]
for (const [tag, p] of prompts) {
  const r = await s.ask({ prompt: p, model: 'gemini-flash', modes: { thinking: false } })
  console.log(`\n===== ${tag} =====`)
  console.log(`markdown=${r.markdown} chars=${r.text.length} code_blocks=${r.code_blocks.length} files=${r.files.length}`)
  console.log('--- first 700 chars of extracted text ---')
  console.log(JSON.stringify(r.text.slice(0, 700)))
}
await s.close()
process.exit(0)
