import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const emptyState = () => ({ events: [], dedupeKeys: [] });

export class EventStore {
  #state = emptyState();
  #writeChain = Promise.resolve();
  #filePath;

  constructor(filePath) {
    this.#filePath = filePath;
  }

  async init() {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    let contents;
    try {
      contents = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.writeFile(this.#filePath, '', { encoding: 'utf8', flag: 'wx' });
      return;
    }

    const hasFinalNewline = contents.endsWith('\n');
    const lines = contents.split('\n');
    if (hasFinalNewline) lines.pop();
    let validByteLength = 0;
    let truncatedPartialLine = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      try {
        const record = JSON.parse(line);
        this.#applyRecord(record);
      } catch (error) {
        const isIncompleteFinalLine = index === lines.length - 1 && !hasFinalNewline;
        if (!isIncompleteFinalLine) {
          throw new Error(`Invalid event log at line ${index + 1}`, { cause: error });
        }
        await fs.truncate(this.#filePath, validByteLength);
        truncatedPartialLine = true;
        break;
      }

      validByteLength += Buffer.byteLength(line, 'utf8');
      if (index < lines.length - 1 || hasFinalNewline) validByteLength += 1;
    }

    if (contents.length > 0 && !hasFinalNewline && !truncatedPartialLine) {
      await fs.appendFile(this.#filePath, '\n', 'utf8');
    }
  }

  #applyRecord(record) {
    if (record?.type === 'enqueue' && record.event?.id && record.event?.dedupeKey) {
      if (this.#state.dedupeKeys.includes(record.event.dedupeKey)) {
        throw new Error(`Duplicate dedupe key in event log: ${record.event.dedupeKey}`);
      }
      this.#state.events.push(record.event);
      this.#state.dedupeKeys.push(record.event.dedupeKey);
      return;
    }

    if (record?.type === 'ack' && record.eventId && record.acknowledgedAt) {
      const event = this.#state.events.find((item) => item.id === record.eventId);
      if (!event) throw new Error(`Acknowledgement references unknown event: ${record.eventId}`);
      event.acknowledgedAt = record.acknowledgedAt;
      return;
    }

    throw new Error('Unsupported event log record');
  }

  async #append(record) {
    const handle = await fs.open(this.#filePath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #mutate(change) {
    const operation = this.#writeChain.then(async () => {
      const next = structuredClone(this.#state);
      const { result, record } = change(next);
      if (record) await this.#append(record);
      this.#state = next;
      return result;
    });
    this.#writeChain = operation.catch(() => {});
    return operation;
  }

  async enqueue(event, dedupeKey) {
    return this.#mutate((state) => {
      if (state.dedupeKeys.includes(dedupeKey)) {
        return {
          result: { duplicate: true, event: state.events.find((item) => item.dedupeKey === dedupeKey) ?? null },
          record: null
        };
      }
      const stored = { ...event, id: randomUUID(), dedupeKey, acknowledgedAt: null };
      state.events.push(stored);
      state.dedupeKeys.push(dedupeKey);
      return {
        result: { duplicate: false, event: stored },
        record: { type: 'enqueue', event: stored }
      };
    });
  }

  async listPending(limit = 10) {
    await this.#writeChain;
    return this.#state.events.filter((event) => event.acknowledgedAt === null).slice(0, limit);
  }

  async acknowledge(id) {
    return this.#mutate((state) => {
      const event = state.events.find((item) => item.id === id);
      if (!event) return { result: { found: false }, record: null };
      if (event.acknowledgedAt) {
        return { result: { found: true, alreadyAcknowledged: true, event }, record: null };
      }
      event.acknowledgedAt = new Date().toISOString();
      return {
        result: { found: true, alreadyAcknowledged: false, event },
        record: { type: 'ack', eventId: event.id, acknowledgedAt: event.acknowledgedAt }
      };
    });
  }

  async stats() {
    await this.#writeChain;
    return {
      pending: this.#state.events.filter((event) => event.acknowledgedAt === null).length,
      total: this.#state.events.length
    };
  }
}
