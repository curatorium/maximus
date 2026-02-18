// Copyright (c) 2026 Mihai Stancu (https://github.com/curatorium)

import { ChannelType, Client, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import fs from 'fs';

class Scribe {
  #pattern = /^\/tasks\/discord\/(?<channel>[^/]+)\/((?<thread>[^/]+)\/)?outbox\/(?<message>.+)\.md$/;

  constructor() {
    this.channels = new Map(); // id → name
    this.channelIds = new Map(); // name → id
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('clientReady', this.onReady);
    this.client.on('messageCreate', this.listen);
    process.on('SIGTERM', this.onShutdown);
    process.on('SIGINT', this.onShutdown);
  }

  start = async () => {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.error('Error: DISCORD_BOT_TOKEN environment variable is required');
      process.exit(1);
    }

    try {
      await this.client.login(process.env.DISCORD_BOT_TOKEN)
    } catch (err) {
      console.error('Failed to connect to Discord:', err);
      process.exit(1);
    }
  };

  listen = (message) => {
    // Ignore messages from Maximus
    if (message.author.bot) {
      return;
    }

    // If it's not a message or a reply, then ignore it
    // Thread creations, system events, etc. are ignored
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) {
      return;
    }

    // Only listen to messages from the OWNER_ID
    // OWNER_ID unset means listen to all messages from all users
    let ownerId = process.env.OWNER_ID;
    if (ownerId && message.author.id.toString() !== ownerId) {
      return;
    }

    // Only listen to messages mentioning the AGENT_NAME
    // AGENT_NAME unset means listen to all messages
    let bot = process.env.AGENT_NAME;
    let mentioned = message.content.includes(bot) || message.mentions.has(this.client.user);
    if (bot && !mentioned) {
      return;
    }

    this.writeTask(message);
  };

  writeTask = async (message) => {
    // Strip the AGENT_NAME or Discord mention from the message content
    let bot = process.env.AGENT_NAME;
    let content = message.content;
    if (bot) {
      content = message.content
          .replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '')
          .replace(new RegExp(bot, 'gi'), '')
          .trim();
    }

    // Include the quoted message as blockquote context
    if (message.reference) {
      try {
        let ref = await message.fetchReference();
        let quoted = ref.content.split('\n').map(l => `> ${l}`).join('\n');
        content = `${quoted}\n\n${content}`;
      } catch (err) {
        console.error(`Failed to fetch referenced message:`, err.message);
      }
    }

    let channelId = message.channelId;
    let threadId = '';
    if (message.channel.isThread() && message.channel.parentId) {
      channelId = message.channel.parentId;
      threadId = `${message.channelId}/`;
    }

    let channel = this.channels.get(channelId);
    let date = message.createdAt.toISOString().replace(new RegExp(/[-.:TZ]/, 'g'), '');
    let inbox = `/tasks/discord/${channel}/${threadId}inbox`;

    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(`${inbox}/${date}.${message.id}.md`, content, 'utf-8');
    console.log(`>>> Received: ${date}.${message.id}.md`);
  };

  respond = async () => {
    if (this.responding) {
      return;
    }

    this.responding = true;
    try {
      for (let file of fs.globSync('/tasks/**/outbox/*.md')) {
        let match = file.match(this.#pattern);
        if (!match) {
          continue;
        }
        let { channel, thread, message } = match.groups;
        try {
          await this.writeReply(channel, thread, message);
        } catch (err) {
          console.error(`Error processing outbox file ${message}.md:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error in outbox poller:', err);
    } finally {
      this.responding = false;
    }
  };

  writeReply = async (channelName, threadId, message) => {
    let base = threadId ? `discord/${channelName}/${threadId}` : `discord/${channelName}`;
    let outbox = `/tasks/${base}/outbox`;
    let sent = `/tasks/${base}/sent`;
    let content = fs.readFileSync(`${outbox}/${message}.md`, 'utf-8').trim() || '(empty)';

    let channel = await this.client.channels.fetch(threadId || this.channelIds.get(channelName));

    for (let chunk of content.split('\n---\n').flatMap(section => this.chunk(section))) {
      await channel.send(chunk);
    }
    console.log(`<<< Sent: ${message}.md`);
    fs.mkdirSync(sent, { recursive: true });
    fs.renameSync(`${outbox}/${message}.md`, `${sent}/${message}.md`);
  }

  chunk = (content, limit = 2000) => {
    if (content.length <= limit) {
      return [content];
    }

    let chunks = [];
    while (content.length > 0) {
      if (content.length <= limit) {
        chunks.push(content);
        break;
      }
      let slice = content.slice(0, limit);
      let split = slice.lastIndexOf('\n');
      if (split <= 0) {
        split = limit;
      }
      chunks.push(content.slice(0, split));
      content = content.slice(split + 1);
    }

    return chunks;
  };

  onReady = async (conn) => {
    console.log(`Connected to Discord as ${conn.user.tag}`);
    this.setupTaskDirs(conn);
    setInterval(this.respond, parseInt(100));
  };

  setupTaskDirs = (conn) => {
    let base = '/tasks/discord';
    fs.mkdirSync(base, { recursive: true });

    conn.guilds.cache
      .flatMap(guild => guild.channels.cache)
      .filter(channel => channel.type === ChannelType.GuildText)
      .forEach(channel => {
        let name = channel.name.replace(/[^-_a-zA-Z0-9]/g, '');
        this.channels.set(channel.id, name);
        this.channelIds.set(name, channel.id);
        fs.mkdirSync(`${base}/${name}`, { recursive: true });
      });

  };

  onShutdown = () => {
    console.log('Shutting down...');
    this.client.destroy();
    process.exit(0);
  };
}

new Scribe().start();
