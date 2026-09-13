import { buildWeatherSnapshot } from '../src/nmc.ts'
import { writeFile } from 'node:fs/promises'

const snapshot = await buildWeatherSnapshot(
  (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
)
const serialized = JSON.stringify(snapshot)
if (process.argv[2]) await writeFile(process.argv[2], serialized, 'utf8')
else process.stdout.write(serialized)
