// Copyright (c) 2026 Mihai Stancu (https://github.com/curatorium)

import { ChannelType, Client, GatewayIntentBits, MessageType, Partials, SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import Handlebars from 'handlebars';
import yaml from 'yaml';

class Scribe {
  #pattern = /^\/tasks\/discord\/(?<channel>[^/]+)\/((?<thread>[^/]+)\/)?outbox\/(?<message>.+)\.md$/;
  #provision = Handlebars.compile(fs.readFileSync(new URL('./provision.yml.hbs', import.meta.url), 'utf-8'), { noEscape: true });

  constructor() {
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
    this.client.on('interactionCreate', this.onInteraction);

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

  writeTask = (message) => {
    // Strip the AGENT_NAME or Discord mention from the message content
    let bot = process.env.AGENT_NAME;
    let content = message.content;
    if (bot) {
      content = message.content
          .replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '')
          .replace(new RegExp(bot, 'gi'), '')
          .trim();
    }

    let channelId = message.channelId;
    let threadId = '';
    if (message.channel.isThread() && message.channel.parentId) {
      channelId = message.channel.parentId;
      threadId = `${message.channelId}/`;
    }

    let date = message.createdAt.toISOString().replace(new RegExp(/[-.:TZ]/, 'g'), '');
    let inbox = `/tasks/discord/${channelId}/${threadId}inbox`;

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

  writeReply = async (channelId, threadId, message) => {
    let base = threadId ? `discord/${channelId}/${threadId}` : `discord/${channelId}`;
    let outbox = `/tasks/${base}/outbox`;
    let sent = `/tasks/${base}/sent`;
    let content = fs.readFileSync(`${outbox}/${message}.md`, 'utf-8').trim() || '(empty)';

    let targetId = threadId || channelId;
    let channel = await this.client.channels.fetch(targetId);
    if (!channel || !channel.isTextBased()) {
      console.error(`Channel ${targetId} is not text-based or not found`);
      return;
    }

    for (let chunk of this.chunk(content)) {
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
    await this.registerCommands(conn);
    setInterval(this.respond, parseInt(process.env.POLL_INTERVAL || 100));
  };

  registerCommands = async (conn) => {
    let authOptions = (cmd) => cmd
      .addBooleanOption(opt => opt
        .setName('credentials')
        .setDescription('Mount Claude credentials file'))
      .addBooleanOption(opt => opt
        .setName('claude-oauth-token')
        .setDescription('Pass CLAUDE_CODE_OAUTH_TOKEN env var'))
      .addBooleanOption(opt => opt
        .setName('anthropic-api-key')
        .setDescription('Pass ANTHROPIC_API_KEY env var'))
      .addBooleanOption(opt => opt
        .setName('gh-credentials')
        .setDescription('Mount GitHub CLI credentials'))
      .addBooleanOption(opt => opt
        .setName('gh-token')
        .setDescription('Pass GH_TOKEN env var'))
      .addBooleanOption(opt => opt
        .setName('ssh')
        .setDescription('Mount SSH key for git push access'));

    let provision = authOptions(new SlashCommandBuilder()
      .setName('provision')
      .setDescription('Generate a docker-compose stub for a new Artifex instance')
      .addStringOption(opt => opt
        .setName('name')
        .setDescription('Service name suffix (e.g. steward)')
        .setRequired(true))
      .addChannelOption(opt => opt
        .setName('channel')
        .setDescription('Discord channel for task routing')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)))
      .addStringOption(opt => opt
        .setName('codebase')
        .setDescription('Absolute path to project dir (empty = no mount)'))
      .addStringOption(opt => opt
        .setName('mounts')
        .setDescription('Comma-separated host:container[:mode] mounts'));

    let provisionAll = authOptions(new SlashCommandBuilder()
      .setName('provision-all')
      .setDescription('Generate docker-compose stubs for all visible channels'));

    await conn.application.commands.set([provision, provisionAll]);
    console.log('Registered slash commands');
  };

  onInteraction = async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    if (interaction.commandName === 'provision') {
      await this.provision(interaction);
    }
    if (interaction.commandName === 'provision-all') {
      await this.provisionAll(interaction);
    }
  };

  provision = async (interaction) => {
    let name = interaction.options.getString('name');
    let channel = interaction.options.getChannel('channel');
    let credentials = interaction.options.getBoolean('credentials');
    let claudeOauthToken = interaction.options.getBoolean('claude-oauth-token');
    let anthropicApiKey = interaction.options.getBoolean('anthropic-api-key');
    let ghCredentials = interaction.options.getBoolean('gh-credentials');
    let ghToken = interaction.options.getBoolean('gh-token');
    let ssh = interaction.options.getBoolean('ssh');
    let codebase = interaction.options.getString('codebase');
    let mounts = (interaction.options.getString('mounts') || '').split(',').map(m => m.trim()).filter(Boolean);

    if (!/^[a-z0-9-]+$/i.test(name)) {
      await interaction.reply({ content: 'Invalid name: only alphanumeric characters and hyphens are allowed.', ephemeral: true });
      return;
    }

    if (!credentials && !claudeOauthToken && !anthropicApiKey) {
      await interaction.reply({ content: 'At least one Claude auth method is required: `credentials`, `claude-oauth-token`, or `anthropic-api-key`.', ephemeral: true });
      return;
    }

    let invalid = mounts.find(m => !/^[^:]+:[^:]+(:[a-z]+)?$/.test(m));
    if (invalid) {
      await interaction.reply({ content: `Invalid mount format: \`${invalid}\`. Expected \`host:container[:mode]\`.`, ephemeral: true });
      return;
    }

    let stub = this.#provision({
      name,
      maximusDir: process.env.MAXIMUS_DIR || '/path/to/maximus',
      channel,
      anthropicApiKey,
      claudeOauthToken,
      credentials,
      ghCredentials,
      ghToken,
      ssh,
      codebase,
      mounts,
    }).trim();

    try {
      yaml.parse(stub);
    } catch (err) {
      await interaction.reply({ content: `Generated YAML is invalid: ${err.message}`, ephemeral: true });
      return;
    }

    let reply = `\`\`\`yaml\n${stub}\n\`\`\``;

    let chunks = this.chunk(reply);
    await interaction.reply(chunks.shift());
    for (let chunk of chunks) {
      await interaction.followUp(chunk);
    }
  };

  provisionAll = async (interaction) => {
    let credentials = interaction.options.getBoolean('credentials');
    let claudeOauthToken = interaction.options.getBoolean('claude-oauth-token');
    let anthropicApiKey = interaction.options.getBoolean('anthropic-api-key');
    let ghCredentials = interaction.options.getBoolean('gh-credentials');
    let ghToken = interaction.options.getBoolean('gh-token');
    let ssh = interaction.options.getBoolean('ssh');
    let maximusDir = process.env.MAXIMUS_DIR || '/path/to/maximus';
    let channels = interaction.guild.channels.cache
      .filter(ch => ch.type === ChannelType.GuildText)
      .map(ch => ({ name: ch.name, id: ch.id }));

    if (channels.length === 0) {
      await interaction.reply({ content: 'No visible text channels found.', ephemeral: true });
      return;
    }

    if (!credentials && !claudeOauthToken && !anthropicApiKey) {
      await interaction.reply({ content: 'At least one Claude auth method is required: `credentials`, `claude-oauth-token`, or `anthropic-api-key`.', ephemeral: true });
      return;
    }

    for (let channel of channels) {
      let stub = this.#provision({
        name: channel.name,
        maximusDir,
        channel,
        anthropicApiKey,
        claudeOauthToken,
        credentials,
        ghCredentials,
        ghToken,
        ssh,
      }).trim();

      let reply = `\`\`\`yaml\n${stub}\n\`\`\``;

      if (!interaction.replied) {
        await interaction.reply(reply);
      } else {
        await interaction.followUp(reply);
      }
    }
  };

  onShutdown = () => {
    console.log('Shutting down...');
    this.client.destroy();
    process.exit(0);
  };
}

new Scribe().start();
