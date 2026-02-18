// Copyright (c) 2026 Mihai Stancu (https://github.com/curatorium)

import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs';

class History {
  constructor() {
    this.channels = new Map(); // id → name
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('clientReady', this.onReady);
    process.on('SIGTERM', this.onShutdown);
    process.on('SIGINT', this.onShutdown);
  }

  start = async () => {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.error('Error: DISCORD_BOT_TOKEN environment variable is required');
      process.exit(1);
    }

    try {
      await this.client.login(process.env.DISCORD_BOT_TOKEN);
    } catch (err) {
      console.error('Failed to connect to Discord:', err);
      process.exit(1);
    }
  };

  onReady = async (conn) => {
    console.log(`Connected to Discord as ${conn.user.tag}`);
    this.discoverChannels(conn);

    for (let [id, name] of this.channels) {
      await this.fetchChannel(id, name);
    }

    console.log('Done.');
    this.client.destroy();
    process.exit(0);
  };

  discoverChannels = (conn) => {
    let base = '/tasks/discord';
    fs.mkdirSync(base, { recursive: true });

    conn.guilds.cache
      .flatMap(guild => guild.channels.cache)
      .filter(channel => channel.type === ChannelType.GuildText)
      .forEach(channel => {
        let name = channel.name.replace(/[^-_a-zA-Z0-9]/g, '');
        this.channels.set(channel.id, name);
      });
  };

  fetchChannel = async (channelId, channelName) => {
    let dir = `/tasks/discord/${channelName}/history`;
    fs.mkdirSync(dir, { recursive: true });

    let channel = await this.client.channels.fetch(channelId);
    let before = undefined;
    let total = 0;

    while (true) {
      let options = { limit: 100 };
      if (before) {
        options.before = before;
      }

      let messages = await channel.messages.fetch(options);
      if (messages.size === 0) {
        break;
      }

      for (let [, message] of messages) {
        this.writeMessage(message, channelName, dir);
        total++;
      }

      before = messages.last().id;
    }

    console.log(`#${channelName}: ${total} messages`);
  };

  writeMessage = (message, channelName, dir) => {
    let date = message.createdAt.toISOString();
    let stamp = date.replace(/[-.:TZ]/g, '');
    let file = `${dir}/${stamp}.${message.id}.md`;

    if (fs.existsSync(file)) {
      return;
    }

    let content = [
      '---',
      `author: ${message.author.username}`,
      `date: ${date}`,
      `channel: ${channelName}`,
      '---',
      '',
      message.content,
      '',
    ].join('\n');

    fs.writeFileSync(file, content, 'utf-8');
  };

  onShutdown = () => {
    console.log('Shutting down...');
    this.client.destroy();
    process.exit(0);
  };
}

new History().start();
