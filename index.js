require("dotenv").config();
const { Client, Collection, GatewayIntentBits, Partials, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ActivityType, PermissionFlagsBits } = require("discord.js");
const { REST, Routes } = require("discord.js");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const ms = require("ms");
const path = require("path");
const fs = require("fs");

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const OWNER_ID  = process.env.OWNER_ID  || "939620924213309451";
const TOKEN     = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID  || null;
const VERSION   = "5.0.0";
const APPEAL    = "To appeal, contact a Network Admin or visit the appeal server.";

const COLORS = {
  primary : 0x5865f2,
  success : 0x57f287,
  warning : 0xfee75c,
  danger  : 0xed4245,
  ban     : 0xed4245,
  kick    : 0xfee75c,
  mute    : 0xeb459e,
  info    : 0x5865f2,
};

const RANK_NAMES = { 0:"No Rank", 1:"Helper", 2:"Moderator", 3:"Server Admin", 4:"Network Admin", 5:"Network Owner" };

// ─── DATABASE ────────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "ts5.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS network_admins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE, username TEXT, rank INTEGER DEFAULT 1, added_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS global_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, reason TEXT, banned_by TEXT, proof TEXT, alt_accounts TEXT DEFAULT '[]', status TEXT DEFAULT 'approved', escalated INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS global_mutes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, reason TEXT, muted_by TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS mod_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, user_id TEXT, username TEXT, guild_id TEXT, guild_name TEXT, reason TEXT, proof TEXT, requested_by TEXT, status TEXT DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, remind_count INTEGER DEFAULT 0, last_reminded TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, guild_id TEXT, reason TEXT, warned_by TEXT, proof TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS user_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, guild_id TEXT, note TEXT, added_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS approved_guilds (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT UNIQUE, guild_name TEXT, owner_id TEXT, member_count INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', approved_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, log_channel_id TEXT, welcome_channel_id TEXT, ban_log_channel_id TEXT, mod_log_channel_id TEXT, lockdown_active INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS dm_notify (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE, added_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS temp_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, guild_id TEXT, reason TEXT, banned_by TEXT, expires_at TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS reputation (user_id TEXT PRIMARY KEY, username TEXT, score INTEGER DEFAULT 100, warnings INTEGER DEFAULT 0, mutes INTEGER DEFAULT 0, bans INTEGER DEFAULT 0, trusted INTEGER DEFAULT 0, watchlisted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, guild_name TEXT, backup_data TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, performed_by TEXT, target_user_id TEXT, target_username TEXT, guild_id TEXT, reason TEXT, created_at TEXT DEFAULT (datetime('now')));
`);
// Ensure owner is rank 5
db.prepare("INSERT OR IGNORE INTO network_admins (user_id, username, rank, added_by) VALUES (?, 'Bot Owner', 5, 'SYSTEM')").run(OWNER_ID);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getRank(userId) {
  if (userId === OWNER_ID) return 5;
  return db.prepare("SELECT rank FROM network_admins WHERE user_id = ?").get(userId)?.rank ?? 0;
}
function rankName(r) { return RANK_NAMES[r] ?? "Unknown"; }

async function checkRank(interaction, min) {
  const r = getRank(interaction.user.id);
  if (r < min) {
    await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("Access Denied").setDescription(`Requires **${rankName(min)}** (Rank ${min}+).\nYour rank: **${rankName(r)}**`)], ephemeral:true });
    return false;
  }
  return true;
}

function guildSettings(guildId) {
  db.prepare("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)").run(guildId);
  return db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId);
}

async function eventLog(guild, embed) {
  const s = guildSettings(guild.id);
  if (!s?.log_channel_id) return;
  const ch = guild.channels.cache.get(s.log_channel_id);
  if (ch) await ch.send({ embeds:[embed] }).catch(()=>{});
}

async function modLog(guild, opts) {
  const s = guildSettings(guild.id);
  if (!s?.mod_log_channel_id) return;
  const ch = guild.channels.cache.get(s.mod_log_channel_id);
  if (!ch) return;
  const { type, target, moderator, reason, color, extra=[] } = opts;
  const e = new EmbedBuilder().setColor(color||COLORS.info).setTitle(type)
    .addFields({ name:"Member", value:`${target.tag||target.username} (${target.id||target})`, inline:false }, { name:"Moderator", value:`${moderator.tag||moderator.username}`, inline:false }, { name:"Reason", value:reason||"No reason", inline:false }, ...extra)
    .setTimestamp();
  await ch.send({ embeds:[e] }).catch(()=>{});
}

async function banLog(guild, opts) {
  const s = guildSettings(guild.id);
  if (!s?.ban_log_channel_id) return;
  const ch = guild.channels.cache.get(s.ban_log_channel_id);
  if (!ch) return;
  const { caseId, type, memberId, staffMember, reason, alts=[] } = opts;
  const label = type==="ban"?"Discord Ban":type==="kick"?"Discord Kick":"Discord Mute";
  const e = new EmbedBuilder().setColor(type==="ban"?COLORS.ban:type==="kick"?COLORS.kick:COLORS.mute).setTitle(label)
    .addFields({ name:"Member", value:`<@${memberId}>`, inline:false }, { name:"Server", value:guild.name, inline:false }, { name:"Staff Member", value:`<@${staffMember.id}>`, inline:false }, { name:"Reason", value:reason, inline:false });
  if (alts.length) e.addFields({ name:"Alt Accounts", value:alts.map(id=>`<@${id}>`).join("\n"), inline:false });
  e.setTimestamp();
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ca_${caseId}`).setLabel("Approved").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cr_${caseId}`).setLabel("Review Needed").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cm_${caseId}`).setLabel(`Remind for ${label.replace("Discord ","")} Proof`).setStyle(ButtonStyle.Primary),
    type==="ban"
      ? new ButtonBuilder().setCustomId(`cu_${caseId}`).setLabel("UnGlobalban").setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`cd_${caseId}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ce_${caseId}`).setLabel("Escalate to Ownership Only Unban").setStyle(ButtonStyle.Danger),
  );
  await ch.send({ embeds:[e], components:[row1, row2] }).catch(()=>{});
}

async function dmPunish(target, guild, type, reason, duration) {
  const labels = { ban:"🔨 Banned", kick:"👢 Kicked", mute:"🔇 Muted", warn:"⚠️ Warned", timeout:"⏱️ Timed Out", tempban:"⏳ Temporarily Banned", softban:"🔨 Soft Banned" };
  const colors = { ban:COLORS.ban, kick:COLORS.kick, mute:COLORS.mute, warn:COLORS.warning, timeout:COLORS.mute, tempban:COLORS.ban, softban:COLORS.ban };
  const e = new EmbedBuilder().setColor(colors[type]||COLORS.info).setTitle(`${labels[type]||type}`)
    .setDescription(`**Server:** ${guild.name}`)
    .addFields({ name:"Reason", value:`> ${reason}` })
    .setFooter({ text: APPEAL }).setTimestamp();
  if (duration) e.addFields({ name:"Duration", value:duration, inline:true });
  if (guild.iconURL()) e.setThumbnail(guild.iconURL({ dynamic:true }));
  let sent = false;
  try { await target.send({ embeds:[e] }); sent = true; } catch {}
  return sent;
}

function ordinal(n) { const s=["th","st","nd","rd"]; const v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }

function approvedGuilds() { return db.prepare("SELECT guild_id FROM approved_guilds WHERE status='approved'").all(); }

// ─── COMMANDS ────────────────────────────────────────────────────────────────
const commands = new Collection();
function reg(data, execute) { commands.set(data.name, { data, execute }); }

// ── GLOBAL ───────────────────────────────────────────────────────────────────
reg(
  new SlashCommandBuilder().setName("globalban").setDescription("Ban a user across all approved guilds")
    .addUserOption(o=>o.setName("user").setDescription("Server member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("Raw User ID").setRequired(false))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence link").setRequired(false)),
  async (i, client) => {
    if (!await checkRank(i,4)) return;
    const u = i.options.getUser("user"), uid = i.options.getString("userid"), reason = i.options.getString("reason"), proof = i.options.getString("proof")||"Not provided";
    if (!u && !uid) return i.reply({ content:"Provide a user or User ID.", ephemeral:true });
    const targetId = u?.id||uid;
    await i.deferReply();
    let username = u?.tag||targetId;
    try { username = (await client.users.fetch(targetId)).tag; } catch {}
    if (db.prepare("SELECT id FROM global_bans WHERE user_id=? AND active=1").get(targetId)) return i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setDescription(`<@${targetId}> is already globally banned.`)] });
    db.prepare("INSERT INTO global_bans (user_id,username,reason,banned_by,proof) VALUES (?,?,?,?,?)").run(targetId,username,reason,i.user.id,proof);
    const cRow = db.prepare("INSERT INTO mod_cases (type,user_id,username,guild_id,guild_name,reason,proof,requested_by,status) VALUES (?,?,?,?,?,?,?,?,'approved') RETURNING id").get("ban",targetId,username,i.guildId,i.guild?.name,reason,proof,i.user.id);
    try { const t=await client.users.fetch(targetId); await dmPunish(t,i.guild,"ban",reason); } catch {}
    let ok=0,fail=0;
    for (const { guild_id } of approvedGuilds()) {
      const g=client.guilds.cache.get(guild_id); if(!g) continue;
      try { await g.members.ban(targetId,{ reason:`[Global Ban] ${reason}` }); ok++; } catch { fail++; }
    }
    if (i.guild && cRow) await banLog(i.guild,{ caseId:cRow.id, type:"ban", memberId:targetId, staffMember:i.user, reason });
    db.prepare("INSERT INTO audit_log (action,performed_by,target_user_id,target_username,guild_id,reason) VALUES (?,?,?,?,?,?)").run("GLOBAL_BAN",i.user.id,targetId,username,i.guildId,reason);
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.ban).setTitle("Global Ban Executed").addFields({ name:"User",value:`<@${targetId}> (${username})`,inline:true },{ name:"Guilds",value:`${ok} banned | ${fail} failed`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("View Titan Development legal information"),

  async (i, client) => {

    const embed = new EmbedBuilder()
      .setTitle("Titan Development  ·  Legal Information")
      .setColor(0x000000)
      .setImage("https://cdn.discordapp.com/attachments/1525015180134580318/1525593844597526600/Banner.png")
      .addFields(
        {
          name: "💳 Refund Policy",
          value:
            "Once a price has been agreed upon, payment must be made upfront before work begins.\n\n" +
            "**Refunds are only issued if:**\n" +
            "• The requested product is not created.\n" +
            "• The order is rejected after payment.\n\n" +
            "**Refunds are NOT issued for:**\n" +
            "• Changing your mind.\n" +
            "• Being unhappy with a completed product.\n" +
            "• Accidental purchases."
        },
        {
          name: "💰 Payment",
          value:
            "Payment must be completed before work begins.\n\n" +
            "Accepted methods:\n" +
            "• PayPal\n" +
            "• Steam Gift Card (certain cases)\n" +
            "• Nitro (certain cases)"
        },
        {
          name: "📦 Orders",
          value:
            "Titan Development may decline requests including:\n" +
            "• Fraudulent transactions\n" +
            "• Client misuse of services\n" +
            "• Unnecessary requests\n" +
            "• Refusal of service at discretion\n\n" +
            "Additional work after payment may require a new order."
        },
        {
          name: "🎫 Ticket Creation",
          value:
            "• Multiple products → Bundle Order ticket\n" +
            "• Single product → Basic Order ticket"
        },
        {
          name: "✏️ Client Approval & Revisions",
          value:
            "Clients must approve materials before finalisation.\n" +
            "Additional revisions outside normal changes may require extra payment."
        },
        {
          name: "🔒 Confidentiality",
          value:
            "All private information shared during an order remains confidential and will not be shared without permission."
        },
        {
          name: "⚖️ Legal",
          value:
            "Titan Development operates under UK law.\n\n" +
            "Terms may be updated at any time. Users are responsible for reviewing changes."
        }
      )
      .setFooter({
        text: "Titan Development • By purchasing/verifying you agree to these terms"
      })
      .setTimestamp();

    await i.reply({
      embeds: [embed]
    });
  }
);

reg(
  new SlashCommandBuilder().setName("globalmute").setDescription("Mute a user across all approved guilds")
    .addUserOption(o=>o.setName("user").setDescription("Server member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("Raw User ID").setRequired(false))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,4)) return;
    const u=i.options.getUser("user"), uid=i.options.getString("userid"), reason=i.options.getString("reason");
    if (!u&&!uid) return i.reply({ content:"Provide a user or User ID.", ephemeral:true });
    const targetId=u?.id||uid; await i.deferReply();
    let username=u?.tag||targetId; try { username=(await client.users.fetch(targetId)).tag; } catch {}
    db.prepare("INSERT OR IGNORE INTO global_mutes (user_id,username,reason,muted_by) VALUES (?,?,?,?)").run(targetId,username,reason,i.user.id);
    let ok=0;
    for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { const m=await g.members.fetch(targetId).catch(()=>null); if(m){await m.timeout(28*24*60*60*1000,`[Global Mute] ${reason}`);ok++;} } catch {} }
    try { const t=await client.users.fetch(targetId); await dmPunish(t,i.guild,"mute",reason); } catch {}
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.mute).setTitle("Global Mute").addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Applied in",value:`${ok} guild(s)`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("globalkick").setDescription("Kick a user from all approved guilds")
    .addUserOption(o=>o.setName("user").setDescription("Server member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("Raw User ID").setRequired(false))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,4)) return;
    const u=i.options.getUser("user"), uid=i.options.getString("userid"), reason=i.options.getString("reason");
    if (!u&&!uid) return i.reply({ content:"Provide a user or User ID.", ephemeral:true });
    const targetId=u?.id||uid; await i.deferReply();
    let username=u?.tag||targetId; try { username=(await client.users.fetch(targetId)).tag; } catch {}
    try { const t=await client.users.fetch(targetId); await dmPunish(t,i.guild,"kick",reason); } catch {}
    let ok=0;
    for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { const m=await g.members.fetch(targetId).catch(()=>null); if(m){await m.kick(`[Global Kick] ${reason}`);ok++;} } catch {} }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.kick).setTitle("Global Kick").addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Kicked from",value:`${ok} guild(s)`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("unglobalban").setDescription("Remove a user from the global ban list")
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i, client) => {
    if (!await checkRank(i,4)) return;
    const targetId=i.options.getString("userid"), reason=i.options.getString("reason")||"No reason";
    await i.deferReply();
    if (!db.prepare("SELECT id FROM global_bans WHERE user_id=? AND active=1").get(targetId)) return i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setDescription("No active global ban found.")] });
    db.prepare("UPDATE global_bans SET active=0 WHERE user_id=? AND active=1").run(targetId);
    let ok=0;
    for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { await g.members.unban(targetId,reason); ok++; } catch {} }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Global Ban Removed").addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Unbanned in",value:`${ok} guild(s)`,inline:true }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("unglobalmute").setDescription("Remove a global mute")
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,4)) return;
    const targetId=i.options.getString("userid"); await i.deferReply();
    db.prepare("UPDATE global_mutes SET active=0 WHERE user_id=? AND active=1").run(targetId);
    let ok=0;
    for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { const m=await g.members.fetch(targetId).catch(()=>null); if(m){await m.timeout(null);ok++;} } catch {} }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Global Mute Removed").addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Unmuted in",value:`${ok} guild(s)`,inline:true }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("massglobalban").setDescription("Ban multiple users globally (comma-separated IDs)")
    .addStringOption(o=>o.setName("userids").setDescription("Comma-separated User IDs").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,5)) return;
    const ids=i.options.getString("userids").split(",").map(s=>s.trim()).filter(Boolean), reason=i.options.getString("reason");
    await i.deferReply();
    let total=0;
    for (const id of ids) { db.prepare("INSERT OR IGNORE INTO global_bans (user_id,username,reason,banned_by) VALUES (?,?,?,?)").run(id,id,reason,i.user.id); for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { await g.members.ban(id,{ reason:`[Mass Global Ban] ${reason}` }); total++; } catch {} } }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.ban).setTitle("Mass Global Ban").addFields({ name:"Users",value:`${ids.length}`,inline:true },{ name:"Total bans",value:`${total}`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("massglobalkick").setDescription("Kick multiple users globally (comma-separated IDs)")
    .addStringOption(o=>o.setName("userids").setDescription("Comma-separated User IDs").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,5)) return;
    const ids=i.options.getString("userids").split(",").map(s=>s.trim()).filter(Boolean), reason=i.options.getString("reason");
    await i.deferReply(); let total=0;
    for (const id of ids) for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { const m=await g.members.fetch(id).catch(()=>null); if(m){await m.kick(reason);total++;} } catch {} }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.kick).setTitle("Mass Global Kick").addFields({ name:"Users",value:`${ids.length}`,inline:true },{ name:"Total kicks",value:`${total}`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("massglobalmute").setDescription("Mute multiple users globally (comma-separated IDs)")
    .addStringOption(o=>o.setName("userids").setDescription("Comma-separated User IDs").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,5)) return;
    const ids=i.options.getString("userids").split(",").map(s=>s.trim()).filter(Boolean), reason=i.options.getString("reason");
    await i.deferReply(); let total=0;
    for (const id of ids) { db.prepare("INSERT OR IGNORE INTO global_mutes (user_id,username,reason,muted_by) VALUES (?,?,?,?)").run(id,id,reason,i.user.id); for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { const m=await g.members.fetch(id).catch(()=>null); if(m){await m.timeout(28*24*60*60*1000,reason);total++;} } catch {} } }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.mute).setTitle("Mass Global Mute").addFields({ name:"Users",value:`${ids.length}`,inline:true },{ name:"Total mutes",value:`${total}`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("requestban").setDescription("Submit a global ban request for review")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(false))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false)),
  async (i, client) => {
    if (!await checkRank(i,2)) return;
    const u=i.options.getUser("user"), uid=i.options.getString("userid"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided";
    if (!u&&!uid) return i.reply({ content:"Provide a user or User ID.", ephemeral:true });
    const targetId=u?.id||uid; let username=u?.tag||targetId; try { username=(await client.users.fetch(targetId)).tag; } catch {}
    const row=db.prepare("INSERT INTO mod_cases (type,user_id,username,guild_id,guild_name,reason,proof,requested_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id").get("ban",targetId,username,i.guildId,i.guild?.name,reason,proof,i.user.id);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle("Ban Request Submitted").setDescription(`Case **#${row.id}** is pending review by a Network Admin.`).addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("requestkick").setDescription("Submit a global kick request")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(false))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false)),
  async (i, client) => {
    if (!await checkRank(i,2)) return;
    const u=i.options.getUser("user"), uid=i.options.getString("userid"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided";
    if (!u&&!uid) return i.reply({ content:"Provide a user or User ID.", ephemeral:true });
    const targetId=u?.id||uid; let username=u?.tag||targetId; try { username=(await client.users.fetch(targetId)).tag; } catch {}
    const row=db.prepare("INSERT INTO mod_cases (type,user_id,username,guild_id,guild_name,reason,proof,requested_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id").get("kick",targetId,username,i.guildId,i.guild?.name,reason,proof,i.user.id);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle("Kick Request Submitted").setDescription(`Case **#${row.id}** pending review.`).addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("requestmute").setDescription("Submit a global mute request")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(false))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false)),
  async (i, client) => {
    if (!await checkRank(i,2)) return;
    const u=i.options.getUser("user"), uid=i.options.getString("userid"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided";
    if (!u&&!uid) return i.reply({ content:"Provide a user or User ID.", ephemeral:true });
    const targetId=u?.id||uid; let username=u?.tag||targetId; try { username=(await client.users.fetch(targetId)).tag; } catch {}
    const row=db.prepare("INSERT INTO mod_cases (type,user_id,username,guild_id,guild_name,reason,proof,requested_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id").get("mute",targetId,username,i.guildId,i.guild?.name,reason,proof,i.user.id);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.mute).setTitle("Mute Request Submitted").setDescription(`Case **#${row.id}** pending review.`).addFields({ name:"User",value:`<@${targetId}>`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("approvecase").setDescription("Approve a pending case")
    .addIntegerOption(o=>o.setName("case_id").setDescription("Case ID").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,4)) return;
    const caseId=i.options.getInteger("case_id"), c=db.prepare("SELECT * FROM mod_cases WHERE id=?").get(caseId);
    if (!c) return i.reply({ content:"Case not found.", ephemeral:true });
    if (c.status!=="pending") return i.reply({ content:`Case is already **${c.status}**.`, ephemeral:true });
    await i.deferReply();
    let applied=0;
    for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(!g) continue; try { if(c.type==="ban"){await g.members.ban(c.user_id,{ reason:`[Case #${caseId} Approved] ${c.reason}` });applied++;} else if(c.type==="mute"){const m=await g.members.fetch(c.user_id).catch(()=>null);if(m){await m.timeout(28*24*60*60*1000,c.reason);applied++;}} else if(c.type==="kick"){const m=await g.members.fetch(c.user_id).catch(()=>null);if(m){await m.kick(c.reason);applied++;}} } catch {} }
    if (c.type==="ban") db.prepare("INSERT OR IGNORE INTO global_bans (user_id,username,reason,banned_by) VALUES (?,?,?,?)").run(c.user_id,c.username,c.reason,c.requested_by);
    db.prepare("UPDATE mod_cases SET status='approved',reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(i.user.id,caseId);
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle(`Case #${caseId} Approved`).addFields({ name:"Type",value:c.type.toUpperCase(),inline:true },{ name:"User",value:`<@${c.user_id}>`,inline:true },{ name:"Applied in",value:`${applied} guild(s)`,inline:true },{ name:"Reason",value:c.reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("denycase").setDescription("Deny a pending case")
    .addIntegerOption(o=>o.setName("case_id").setDescription("Case ID").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,4)) return;
    const caseId=i.options.getInteger("case_id"), reason=i.options.getString("reason")||"No reason", c=db.prepare("SELECT * FROM mod_cases WHERE id=?").get(caseId);
    if (!c) return i.reply({ content:"Case not found.", ephemeral:true });
    db.prepare("UPDATE mod_cases SET status='denied',reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(i.user.id,caseId);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle(`Case #${caseId} Denied`).addFields({ name:"User",value:`<@${c.user_id}>`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

// ── MODERATION ───────────────────────────────────────────────────────────────
reg(
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false))
    .addIntegerOption(o=>o.setName("delete_days").setDescription("Days of messages to delete (0-7)").setMinValue(0).setMaxValue(7).setRequired(false)),
  async (i) => {
    if (!await checkRank(i,3)) return;
    const target=i.options.getMember("user"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided", delDays=i.options.getInteger("delete_days")??0;
    if (!target||!target.bannable) return i.reply({ content:"Cannot ban that member.", ephemeral:true });
    await i.deferReply();
    const dmSent=await dmPunish(target.user,i.guild,"ban",reason);
    await target.ban({ reason:`${reason} | By: ${i.user.tag}`, deleteMessageDays:delDays });
    const row=db.prepare("INSERT INTO mod_cases (type,user_id,username,guild_id,guild_name,reason,proof,requested_by,status) VALUES (?,?,?,?,?,?,?,?,'approved') RETURNING id").get("ban",target.id,target.user.tag,i.guildId,i.guild.name,reason,proof,i.user.id);
    await modLog(i.guild,{ type:"BAN",target:target.user,moderator:i.user,reason,color:COLORS.ban });
    await banLog(i.guild,{ caseId:row.id,type:"ban",memberId:target.id,staffMember:i.user,reason });
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.ban).setTitle("Member Banned").addFields({ name:"User",value:target.user.tag,inline:true },{ name:"Reason",value:reason },{ name:"DM Sent",value:dmSent?"Yes":"No",inline:true }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const target=i.options.getMember("user"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided";
    if (!target||!target.kickable) return i.reply({ content:"Cannot kick that member.", ephemeral:true });
    await i.deferReply();
    const dmSent=await dmPunish(target.user,i.guild,"kick",reason);
    await target.kick(`${reason} | By: ${i.user.tag}`);
    const row=db.prepare("INSERT INTO mod_cases (type,user_id,username,guild_id,guild_name,reason,proof,requested_by,status) VALUES (?,?,?,?,?,?,?,?,'approved') RETURNING id").get("kick",target.id,target.user.tag,i.guildId,i.guild.name,reason,proof,i.user.id);
    await modLog(i.guild,{ type:"KICK",target:target.user,moderator:i.user,reason,color:COLORS.kick });
    await banLog(i.guild,{ caseId:row.id,type:"kick",memberId:target.id,staffMember:i.user,reason });
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.kick).setTitle("Member Kicked").addFields({ name:"User",value:target.user.tag,inline:true },{ name:"Reason",value:reason },{ name:"DM Sent",value:dmSent?"Yes":"No",inline:true }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("mute").setDescription("Timeout a member")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("duration").setDescription("Duration e.g. 10m 1h 7d").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const target=i.options.getMember("user"), durStr=i.options.getString("duration"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided";
    if (!target) return i.reply({ content:"Member not found.", ephemeral:true });
    const dur=ms(durStr); if (!dur||dur>28*24*60*60*1000) return i.reply({ content:"Invalid duration. Max 28d.", ephemeral:true });
    const dmSent=await dmPunish(target.user,i.guild,"mute",reason,durStr);
    await target.timeout(dur,`${reason} | By: ${i.user.tag}`);
    db.prepare("INSERT OR IGNORE INTO reputation (user_id,username) VALUES (?,?)").run(target.id,target.user.tag);
    db.prepare("UPDATE reputation SET mutes=mutes+1,score=MAX(0,score-10) WHERE user_id=?").run(target.id);
    await modLog(i.guild,{ type:"MUTE",target:target.user,moderator:i.user,reason,color:COLORS.mute,extra:[{ name:"Duration",value:durStr,inline:true },{ name:"DM",value:dmSent?"Yes":"No",inline:true }] });
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.mute).setTitle("Member Muted").addFields({ name:"User",value:target.user.tag,inline:true },{ name:"Duration",value:durStr,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(new SlashCommandBuilder().setName("unmute").setDescription("Remove a timeout").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)),
  async (i) => { if (!await checkRank(i,2)) return; const t=i.options.getMember("user"); if(!t) return i.reply({ content:"Member not found.",ephemeral:true }); await t.timeout(null); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${t.id}> has been unmuted.`)] }); }
);

reg(
  new SlashCommandBuilder().setName("warn").setDescription("Warn a member")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true))
    .addStringOption(o=>o.setName("proof").setDescription("Evidence").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const target=i.options.getMember("user"), reason=i.options.getString("reason"), proof=i.options.getString("proof")||"Not provided";
    if (!target) return i.reply({ content:"Member not found.", ephemeral:true });
    db.prepare("INSERT INTO warnings (user_id,guild_id,reason,warned_by,proof) VALUES (?,?,?,?,?)").run(target.id,i.guildId,reason,i.user.id,proof);
    db.prepare("INSERT OR IGNORE INTO reputation (user_id,username) VALUES (?,?)").run(target.id,target.user.tag);
    db.prepare("UPDATE reputation SET warnings=warnings+1,score=MAX(0,score-5) WHERE user_id=?").run(target.id);
    const total=db.prepare("SELECT COUNT(*) as c FROM warnings WHERE user_id=? AND guild_id=? AND active=1").get(target.id,i.guildId)?.c||0;
    await dmPunish(target.user,i.guild,"warn",reason);
    await modLog(i.guild,{ type:"WARN",target:target.user,moderator:i.user,reason,color:COLORS.warning });
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle("Member Warned").addFields({ name:"User",value:target.user.tag,inline:true },{ name:"Total Warnings",value:`${total}`,inline:true },{ name:"Reason",value:reason },{ name:"Proof",value:proof }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("unwarn").setDescription("Remove a warning by ID").addIntegerOption(o=>o.setName("warning_id").setDescription("Warning ID from /history").setRequired(true)),
  async (i) => {
    if (!await checkRank(i,3)) return;
    const wid=i.options.getInteger("warning_id"), w=db.prepare("SELECT * FROM warnings WHERE id=?").get(wid);
    if (!w) return i.reply({ content:"Warning not found.", ephemeral:true });
    db.prepare("UPDATE warnings SET active=0 WHERE id=?").run(wid);
    db.prepare("UPDATE reputation SET warnings=MAX(0,warnings-1),score=MIN(100,score+5) WHERE user_id=?").run(w.user_id);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Warning Removed").addFields({ name:"Warning ID",value:`${wid}`,inline:true },{ name:"User",value:`<@${w.user_id}>`,inline:true }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("softban").setDescription("Ban then unban (clears messages)")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i) => {
    if (!await checkRank(i,3)) return;
    const t=i.options.getMember("user"), reason=i.options.getString("reason");
    if (!t) return i.reply({ content:"Member not found.", ephemeral:true });
    await dmPunish(t.user,i.guild,"softban",reason);
    await i.guild.members.ban(t.id,{ reason, deleteMessageDays:7 });
    await i.guild.members.unban(t.id,"Softban — messages cleared");
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.ban).setTitle("Soft Banned").setDescription(`<@${t.id}> was softbanned — messages deleted.`).addFields({ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("unban").setDescription("Unban a user")
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,3)) return;
    const uid=i.options.getString("userid"), reason=i.options.getString("reason")||"No reason";
    try { await i.guild.members.unban(uid,reason); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${uid}> unbanned.`)] }); }
    catch { await i.reply({ content:"Could not unban that user.", ephemeral:true }); }
  }
);

reg(
  new SlashCommandBuilder().setName("tempban").setDescription("Temporarily ban a user (auto-unbans)")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("duration").setDescription("e.g. 1h 7d 30d").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i) => {
    if (!await checkRank(i,3)) return;
    const t=i.options.getMember("user"), durStr=i.options.getString("duration"), reason=i.options.getString("reason");
    if (!t) return i.reply({ content:"Member not found.", ephemeral:true });
    const dur=ms(durStr); if (!dur) return i.reply({ content:"Invalid duration.", ephemeral:true });
    const expires=new Date(Date.now()+dur).toISOString();
    await dmPunish(t.user,i.guild,"tempban",reason,durStr);
    await i.guild.members.ban(t.id,{ reason:`[Temp Ban ${durStr}] ${reason}` });
    db.prepare("INSERT INTO temp_bans (user_id,guild_id,reason,banned_by,expires_at) VALUES (?,?,?,?,?)").run(t.id,i.guildId,reason,i.user.id,expires);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.ban).setTitle("Temp Ban").addFields({ name:"User",value:t.user.tag,inline:true },{ name:"Duration",value:durStr,inline:true },{ name:"Expires",value:`<t:${Math.floor((Date.now()+dur)/1000)}:R>`,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("duration").setDescription("e.g. 10m 1h").setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const t=i.options.getMember("user"), durStr=i.options.getString("duration"), reason=i.options.getString("reason")||"No reason";
    if (!t) return i.reply({ content:"Member not found.", ephemeral:true });
    const dur=ms(durStr); if (!dur) return i.reply({ content:"Invalid duration.", ephemeral:true });
    await dmPunish(t.user,i.guild,"timeout",reason,durStr);
    await t.timeout(dur,reason);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.mute).setTitle("Timed Out").addFields({ name:"User",value:t.user.tag,inline:true },{ name:"Duration",value:durStr,inline:true },{ name:"Reason",value:reason }).setTimestamp()] });
  }
);

reg(new SlashCommandBuilder().setName("untimeout").setDescription("Remove a timeout").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)),
  async (i) => { if (!await checkRank(i,2)) return; const t=i.options.getMember("user"); if(!t) return i.reply({ content:"Member not found.",ephemeral:true }); await t.timeout(null); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Timeout removed from <@${t.id}>.`)] }); }
);

reg(
  new SlashCommandBuilder().setName("clear").setDescription("Delete messages").addIntegerOption(o=>o.setName("amount").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true)).addUserOption(o=>o.setName("user").setDescription("Only from this user").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const amt=i.options.getInteger("amount"), filterUser=i.options.getUser("user");
    await i.deferReply({ ephemeral:true });
    let msgs=await i.channel.messages.fetch({ limit:100 });
    if (filterUser) msgs=msgs.filter(m=>m.author.id===filterUser.id);
    const del=await i.channel.bulkDelete([...msgs.values()].slice(0,amt),true).catch(()=>null);
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Deleted **${del?.size??0}** message(s).`)] });
  }
);

reg(
  new SlashCommandBuilder().setName("history").setDescription("View moderation history for a user")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(false))
    .addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,1)) return;
    const u=i.options.getUser("user"), uid=i.options.getString("userid"), targetId=u?.id||uid;
    if (!targetId) return i.reply({ content:"Provide a user or user ID.", ephemeral:true });
    const warns=db.prepare("SELECT * FROM warnings WHERE user_id=? AND guild_id=? ORDER BY created_at DESC LIMIT 10").all(targetId,i.guildId);
    const cases=db.prepare("SELECT * FROM mod_cases WHERE user_id=? ORDER BY created_at DESC LIMIT 5").all(targetId);
    const rep=db.prepare("SELECT * FROM reputation WHERE user_id=?").get(targetId);
    const e=new EmbedBuilder().setColor(COLORS.info).setTitle(`History — <@${targetId}>`).addFields({ name:"Rep Score",value:rep?`${rep.score}/100`:"No data",inline:true },{ name:"Bans",value:`${rep?.bans??0}`,inline:true },{ name:"Mutes",value:`${rep?.mutes??0}`,inline:true });
    if (warns.length) e.addFields({ name:"Warnings",value:warns.map(w=>`**#${w.id}** ${w.reason} *(${w.created_at.slice(0,10)})*`).join("\n"),inline:false });
    if (cases.length) e.addFields({ name:"Network Cases",value:cases.map(c=>`**#${c.id}** ${c.type.toUpperCase()} — ${c.reason} [${c.status}]`).join("\n"),inline:false });
    if (!warns.length&&!cases.length) e.setDescription("No history found.");
    await i.reply({ embeds:[e] });
  }
);

reg(
  new SlashCommandBuilder().setName("notes").setDescription("Manage member notes")
    .addSubcommand(s=>s.setName("add").setDescription("Add note").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("note").setDescription("Note").setRequired(true)))
    .addSubcommand(s=>s.setName("view").setDescription("View notes").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const sub=i.options.getSubcommand(), t=i.options.getUser("user");
    if (sub==="add") { db.prepare("INSERT INTO user_notes (user_id,guild_id,note,added_by) VALUES (?,?,?,?)").run(t.id,i.guildId,i.options.getString("note"),i.user.id); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Note added to <@${t.id}>.`)] }); }
    const notes=db.prepare("SELECT * FROM user_notes WHERE user_id=? AND guild_id=? ORDER BY created_at DESC").all(t.id,i.guildId);
    if (!notes.length) return i.reply({ content:"No notes.", ephemeral:true });
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle(`Notes — ${t.tag}`).setDescription(notes.map((n,idx)=>`**${idx+1}.** ${n.note} — <@${n.added_by}> (${n.created_at.slice(0,10)})`).join("\n"))] });
  }
);

reg(
  new SlashCommandBuilder().setName("nickname").setDescription("Change a member's nickname")
    .addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("nickname").setDescription("New nickname (blank = reset)").setRequired(false)),
  async (i) => {
    if (!await checkRank(i,2)) return;
    const t=i.options.getMember("user"), nick=i.options.getString("nickname")??null;
    if (!t) return i.reply({ content:"Member not found.", ephemeral:true });
    await t.setNickname(nick);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Nickname ${nick?`set to **${nick}**`:"reset"} for <@${t.id}>.`)] });
  }
);

// ── ADMIN ────────────────────────────────────────────────────────────────────
reg(
  new SlashCommandBuilder().setName("adminset").setDescription("Configure bot settings")
    .addSubcommand(s=>s.setName("add-admin").setDescription("Add network admin").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)).addIntegerOption(o=>o.setName("rank").setDescription("Rank 1-5").setMinValue(1).setMaxValue(5).setRequired(true)))
    .addSubcommand(s=>s.setName("remove-admin").setDescription("Remove network admin").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s=>s.setName("list").setDescription("List all admins"))
    .addSubcommand(s=>s.setName("set-logs").setDescription("Set a log channel")
      .addStringOption(o=>o.setName("type").setDescription("Channel type").setRequired(true).addChoices({ name:"Event Logs",value:"log_channel_id" },{ name:"Welcome Channel",value:"welcome_channel_id" },{ name:"Ban Logs",value:"ban_log_channel_id" },{ name:"Mod Logs",value:"mod_log_channel_id" }))
      .addChannelOption(o=>o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText).setRequired(true))),
  async (i) => {
    const sub=i.options.getSubcommand();
    if (sub==="list") { const admins=db.prepare("SELECT * FROM network_admins ORDER BY rank DESC").all(); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle("Network Admins").setDescription(admins.length?admins.map(a=>`**[${rankName(a.rank)}]** <@${a.user_id}> — ${a.username}`).join("\n"):"No admins.")] }); }
    if (sub==="set-logs") { if (!await checkRank(i,3)) return; const type=i.options.getString("type"), ch=i.options.getChannel("channel"); db.prepare("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)").run(i.guildId); db.prepare(`UPDATE guild_settings SET ${type}=? WHERE guild_id=?`).run(ch.id,i.guildId); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Log channel set to <#${ch.id}>.`)] }); }
    if (!await checkRank(i,5)) return;
    const target=i.options.getUser("user");
    if (sub==="add-admin") { const rank=i.options.getInteger("rank"); db.prepare("INSERT OR REPLACE INTO network_admins (user_id,username,rank,added_by) VALUES (?,?,?,?)").run(target.id,target.tag,rank,i.user.id); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${target.id}> set to **${rankName(rank)}** (Rank ${rank}).`)] }); }
    if (sub==="remove-admin") { db.prepare("DELETE FROM network_admins WHERE user_id=?").run(target.id); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${target.id}> removed from network admins.`)] }); }
  }
);

reg(
  new SlashCommandBuilder().setName("permissions").setDescription("Check your or another user's rank")
    .addUserOption(o=>o.setName("user").setDescription("User").setRequired(false)),
  async (i) => {
    const t=i.options.getUser("user")??i.user, r=getRank(t.id);
    const perms={ 5:["Everything"], 4:["Review cases","Manage reputation","View all logs"], 3:["Server mod","Security config","Lockdowns","Backups"], 2:["Warn/timeout","View reports"], 1:["Read-only tools"], 0:["No permissions"] };
    await i.reply({ embeds:[new EmbedBuilder().setColor(r>=4?COLORS.danger:r>=2?COLORS.warning:COLORS.info).setTitle(`Permissions — ${t.tag}`).addFields({ name:"Rank",value:`**${r}** — ${rankName(r)}`,inline:true },{ name:"Permissions",value:(perms[r]||perms[0]).map(p=>`• ${p}`).join("\n"),inline:false }).setThumbnail(t.displayAvatarURL({ dynamic:true })).setTimestamp()], ephemeral:true });
  }
);

reg(
  new SlashCommandBuilder().setName("about").setDescription("About Terminal Security 5"),
  async (i) => {
    const gb=db.prepare("SELECT COUNT(*) as c FROM approved_guilds WHERE status='approved'").get()?.c??0;
    const bans=db.prepare("SELECT COUNT(*) as c FROM global_bans WHERE active=1").get()?.c??0;
    const admins=db.prepare("SELECT COUNT(*) as c FROM network_admins").get()?.c??0;
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.primary).setTitle("Terminal Security 5").setDescription("Terminal Security 5 is an enterprise-grade Discord security network. It protects servers from raids, scammers, and bad actors by sharing moderation data and enforcement actions across every approved server in real time.").addFields({ name:"Made by",value:`<@${OWNER_ID}>`,inline:true },{ name:"Version",value:VERSION,inline:true },{ name:"Approved Servers",value:`${gb}`,inline:true },{ name:"Active Global Bans",value:`${bans}`,inline:true },{ name:"Network Admins",value:`${admins}`,inline:true }).setThumbnail(i.client.user.displayAvatarURL({ dynamic:true })).setFooter({ text:"Terminal Security 5 — Protecting networks at scale" }).setTimestamp()] });
  }
);

reg(
  new SlashCommandBuilder().setName("dm").setDescription("Send a DM to a user through the bot")
    .addUserOption(o=>o.setName("user").setDescription("Recipient").setRequired(true))
    .addStringOption(o=>o.setName("message").setDescription("Message").setRequired(true)),
  async (i) => {
    if (!await checkRank(i,3)) return;
    const target=i.options.getUser("user"), msg=i.options.getString("message"), r=getRank(i.user.id);
    const e=new EmbedBuilder().setColor(COLORS.primary).setAuthor({ name:i.guild?.name??"Terminal Security Network",iconURL:i.guild?.iconURL({ dynamic:true })??undefined }).setTitle("Message from Network Staff").setDescription(`> ${msg}`).addFields({ name:"Sent by",value:`${i.user.tag} — **${rankName(r)}**`,inline:true }).setFooter({ text:"You cannot reply to this message directly. Contact a staff member." }).setTimestamp();
    let sent=false; try { await target.send({ embeds:[e] }); sent=true; } catch {}
    await i.reply({ embeds:[new EmbedBuilder().setColor(sent?COLORS.success:COLORS.danger).setTitle(sent?"DM Sent":"DM Failed").addFields({ name:"Recipient",value:target.tag,inline:true },{ name:"Status",value:sent?"Delivered":"Could not DM (DMs may be closed)",inline:true },{ name:"Message",value:`> ${msg.slice(0,200)}` }).setTimestamp()], ephemeral:true });
  }
);

reg(
  new SlashCommandBuilder().setName("dmnotify").setDescription("Manage DM forwarding recipients")
    .addSubcommand(s=>s.setName("add").setDescription("Add recipient").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove recipient").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s=>s.setName("list").setDescription("View list")),
  async (i) => {
    if (!await checkRank(i,4)) return;
    const sub=i.options.getSubcommand();
    if (sub==="list") { const list=db.prepare("SELECT * FROM dm_notify").all(); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle("DM Notify List").setDescription(list.length?list.map(r=>`<@${r.user_id}>`).join("\n"):"Empty.")], ephemeral:true }); }
    const u=i.options.getUser("user");
    if (sub==="add") { db.prepare("INSERT OR IGNORE INTO dm_notify (user_id,added_by) VALUES (?,?)").run(u.id,i.user.id); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${u.id}> will now receive DM notifications.`)] }); }
    db.prepare("DELETE FROM dm_notify WHERE user_id=?").run(u.id);
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${u.id}> removed from notify list.`)] });
  }
);

reg(
  new SlashCommandBuilder().setName("userinfo").setDescription("View info about a user")
    .addUserOption(o=>o.setName("user").setDescription("User").setRequired(false)),
  async (i) => {
    const t=i.options.getMember("user")??i.member, u=t.user??t;
    const rep=db.prepare("SELECT * FROM reputation WHERE user_id=?").get(u.id);
    const bans=db.prepare("SELECT COUNT(*) as c FROM global_bans WHERE user_id=? AND active=1").get(u.id)?.c??0;
    const warns=db.prepare("SELECT COUNT(*) as c FROM warnings WHERE user_id=? AND active=1").get(u.id)?.c??0;
    await i.reply({ embeds:[new EmbedBuilder().setColor(bans>0?COLORS.danger:COLORS.info).setTitle(`User Info — ${u.tag}`).setThumbnail(u.displayAvatarURL({ dynamic:true })).addFields({ name:"ID",value:u.id,inline:true },{ name:"Created",value:`<t:${Math.floor(u.createdTimestamp/1000)}:R>`,inline:true },{ name:"Rep Score",value:rep?`${rep.score}/100`:"None",inline:true },{ name:"Global Bans",value:`${bans}`,inline:true },{ name:"Warnings",value:`${warns}`,inline:true },{ name:"Trusted",value:rep?.trusted?"Yes":"No",inline:true },{ name:"Watchlisted",value:rep?.watchlisted?"Yes":"No",inline:true }).setTimestamp()] });
  }
);

reg(new SlashCommandBuilder().setName("serverinfo").setDescription("View server info"), async (i) => {
  const g=await i.guild.fetch();
  await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle(`Server Info — ${g.name}`).setThumbnail(g.iconURL({ dynamic:true })).addFields({ name:"ID",value:g.id,inline:true },{ name:"Members",value:`${g.memberCount}`,inline:true },{ name:"Owner",value:`<@${g.ownerId}>`,inline:true },{ name:"Channels",value:`${g.channels.cache.size}`,inline:true },{ name:"Roles",value:`${g.roles.cache.size}`,inline:true },{ name:"Boost Level",value:`Level ${g.premiumTier}`,inline:true },{ name:"Created",value:`<t:${Math.floor(g.createdTimestamp/1000)}:R>`,inline:true }).setTimestamp()] });
});

reg(new SlashCommandBuilder().setName("networkinfo").setDescription("View network statistics"), async (i) => {
  const approved=db.prepare("SELECT COUNT(*) as c FROM approved_guilds WHERE status='approved'").get()?.c??0;
  const pending=db.prepare("SELECT COUNT(*) as c FROM approved_guilds WHERE status='pending'").get()?.c??0;
  const bans=db.prepare("SELECT COUNT(*) as c FROM global_bans WHERE active=1").get()?.c??0;
  const mutes=db.prepare("SELECT COUNT(*) as c FROM global_mutes WHERE active=1").get()?.c??0;
  const cases=db.prepare("SELECT COUNT(*) as c FROM mod_cases").get()?.c??0;
  await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.primary).setTitle("Network Info").addFields({ name:"Approved Servers",value:`${approved}`,inline:true },{ name:"Pending",value:`${pending}`,inline:true },{ name:"Active Global Bans",value:`${bans}`,inline:true },{ name:"Active Global Mutes",value:`${mutes}`,inline:true },{ name:"Total Cases",value:`${cases}`,inline:true }).setTimestamp()] });
});

reg(
  new SlashCommandBuilder().setName("approveguild").setDescription("Approve a guild to join the network").addStringOption(o=>o.setName("guild_id").setDescription("Guild ID").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,5)) return;
    const gid=i.options.getString("guild_id");
    db.prepare("UPDATE approved_guilds SET status='approved',approved_by=? WHERE guild_id=?").run(i.user.id,gid);
    try { const g=client.guilds.cache.get(gid); if(g){ const o=await client.users.fetch(g.ownerId); await o.send({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Server Approved").setDescription(`**${g.name}** is now approved in the TS5 network.`)] }); } } catch {}
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Guild Approved").setDescription(`Guild \`${gid}\` is now approved.`)] });
  }
);

reg(new SlashCommandBuilder().setName("denyguild").setDescription("Deny a guild's application").addStringOption(o=>o.setName("guild_id").setDescription("Guild ID").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i) => { if (!await checkRank(i,5)) return; db.prepare("UPDATE approved_guilds SET status='denied' WHERE guild_id=?").run(i.options.getString("guild_id")); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("Guild Denied").setDescription(`Guild denied. Reason: ${i.options.getString("reason")||"None"}`).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("listguilds").setDescription("List all network guilds").addStringOption(o=>o.setName("status").setDescription("Filter").addChoices({ name:"All",value:"all" },{ name:"Approved",value:"approved" },{ name:"Pending",value:"pending" },{ name:"Denied",value:"denied" }).setRequired(false)),
  async (i) => {
    if (!await checkRank(i,4)) return;
    const status=i.options.getString("status")||"all";
    const guilds=status==="all"?db.prepare("SELECT * FROM approved_guilds ORDER BY status,guild_name").all():db.prepare("SELECT * FROM approved_guilds WHERE status=? ORDER BY guild_name").all(status);
    const emoji={ approved:"✅",pending:"⏳",denied:"❌" };
    await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle("Network Guilds").setDescription(guilds.length?guilds.slice(0,25).map(g=>`${emoji[g.status]||"❓"} **${g.guild_name}** (\`${g.guild_id}\`)`).join("\n"):"No guilds.").setFooter({ text:`${guilds.length} guild(s)` })], ephemeral:true });
  }
);

// ── SECURITY ─────────────────────────────────────────────────────────────────
reg(new SlashCommandBuilder().setName("lock").setDescription("Lock a channel").addChannelOption(o=>o.setName("channel").setDescription("Channel (default: current)").setRequired(false)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i) => { if (!await checkRank(i,3)) return; const ch=i.options.getChannel("channel")??i.channel, r=i.options.getString("reason")||"Locked by staff"; await ch.permissionOverwrites.edit(i.guild.roles.everyone,{ SendMessages:false },{ reason:r }); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("Channel Locked").setDescription(`<#${ch.id}> locked.\n**Reason:** ${r}`).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("unlock").setDescription("Unlock a channel").addChannelOption(o=>o.setName("channel").setDescription("Channel").setRequired(false)),
  async (i) => { if (!await checkRank(i,3)) return; const ch=i.options.getChannel("channel")??i.channel; await ch.permissionOverwrites.edit(i.guild.roles.everyone,{ SendMessages:null }); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Channel Unlocked").setDescription(`<#${ch.id}> unlocked.`).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("slowmode").setDescription("Set channel slowmode").addIntegerOption(o=>o.setName("seconds").setDescription("0 to disable, max 21600").setMinValue(0).setMaxValue(21600).setRequired(true)).addChannelOption(o=>o.setName("channel").setDescription("Channel").setRequired(false)),
  async (i) => { if (!await checkRank(i,2)) return; const s=i.options.getInteger("seconds"), ch=i.options.getChannel("channel")??i.channel; await ch.setRateLimitPerUser(s); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setDescription(s===0?`Slowmode disabled in <#${ch.id}>.`:`Slowmode set to **${s}s** in <#${ch.id}>.`)] }); }
);

reg(new SlashCommandBuilder().setName("checkban").setDescription("Check if a user is globally banned").addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(true)),
  async (i) => { if (!await checkRank(i,1)) return; const uid=i.options.getString("userid"), ban=db.prepare("SELECT * FROM global_bans WHERE user_id=? AND active=1").get(uid); if(!ban) return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${uid}> is **not** globally banned.`)], ephemeral:true }); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("Globally Banned").addFields({ name:"User",value:`<@${uid}>`,inline:true },{ name:"Reason",value:ban.reason },{ name:"Date",value:ban.created_at.slice(0,10),inline:true }).setTimestamp()], ephemeral:true }); }
);

reg(new SlashCommandBuilder().setName("ghostban").setDescription("Ban silently (no DM)").addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i) => { if (!await checkRank(i,4)) return; const uid=i.options.getString("userid"), r=i.options.getString("reason"); try { await i.guild.members.ban(uid,{ reason:`[Ghost Ban] ${r}` }); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.ban).setTitle("Ghost Ban").setDescription(`User \`${uid}\` silently banned.`).setTimestamp()], ephemeral:true }); } catch { await i.reply({ content:"Failed to ban.",ephemeral:true }); } }
);

reg(new SlashCommandBuilder().setName("vckick").setDescription("Disconnect a member from voice").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)),
  async (i) => { if (!await checkRank(i,2)) return; const t=i.options.getMember("user"); if(!t) return i.reply({ content:"Not found.",ephemeral:true }); if(!t.voice.channel) return i.reply({ content:"Not in a voice channel.",ephemeral:true }); await t.voice.disconnect(); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setDescription(`<@${t.id}> disconnected from voice.`)] }); }
);

reg(new SlashCommandBuilder().setName("stripall").setDescription("Strip all roles from a member").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i) => { if (!await checkRank(i,4)) return; const t=i.options.getMember("user"), r=i.options.getString("reason"); if(!t) return i.reply({ content:"Not found.",ephemeral:true }); const roles=t.roles.cache.filter(r=>r.id!==i.guildId&&!r.managed); await t.roles.remove(roles,r); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("Roles Stripped").addFields({ name:"User",value:t.user.tag,inline:true },{ name:"Removed",value:`${roles.size}`,inline:true },{ name:"Reason",value:r }).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("roleinfo").setDescription("View role info").addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)),
  async (i) => { const r=i.options.getRole("role"); await i.reply({ embeds:[new EmbedBuilder().setColor(r.color||COLORS.info).setTitle(`Role — ${r.name}`).addFields({ name:"ID",value:r.id,inline:true },{ name:"Color",value:r.hexColor,inline:true },{ name:"Members",value:`${r.members.size}`,inline:true },{ name:"Hoisted",value:r.hoist?"Yes":"No",inline:true },{ name:"Mentionable",value:r.mentionable?"Yes":"No",inline:true },{ name:"Created",value:`<t:${Math.floor(r.createdTimestamp/1000)}:R>`,inline:true }).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("channelinfo").setDescription("View channel info").addChannelOption(o=>o.setName("channel").setDescription("Channel").setRequired(false)),
  async (i) => { const ch=i.options.getChannel("channel")??i.channel; await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle(`Channel — #${ch.name}`).addFields({ name:"ID",value:ch.id,inline:true },{ name:"Type",value:ch.type.toString(),inline:true },{ name:"Category",value:ch.parent?.name||"None",inline:true },{ name:"Topic",value:ch.topic||"None",inline:false },{ name:"NSFW",value:ch.nsfw?"Yes":"No",inline:true },{ name:"Slowmode",value:`${ch.rateLimitPerUser??0}s`,inline:true }).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("botstats").setDescription("Bot performance stats"), async (i, client) => {
  const up=process.uptime(), h=Math.floor(up/3600), m=Math.floor((up%3600)/60), s=Math.floor(up%60);
  const mem=process.memoryUsage();
  await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.primary).setTitle("TS5 — Stats").addFields({ name:"Version",value:VERSION,inline:true },{ name:"Uptime",value:`${h}h ${m}m ${s}s`,inline:true },{ name:"Guilds",value:`${client.guilds.cache.size}`,inline:true },{ name:"Commands",value:`${commands.size}`,inline:true },{ name:"Memory",value:`${(mem.heapUsed/1024/1024).toFixed(1)} MB`,inline:true },{ name:"Node",value:process.version,inline:true }).setTimestamp()] });
});

reg(new SlashCommandBuilder().setName("invites").setDescription("View all active server invites"), async (i) => {
  if (!await checkRank(i,2)) return;
  const inv=await i.guild.invites.fetch(), sorted=[...inv.values()].sort((a,b)=>b.uses-a.uses);
  await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle("Invites").setDescription(sorted.length?sorted.slice(0,20).map(v=>`**${v.code}** — ${v.uses} uses | <@${v.inviter?.id}> | Expires: ${v.expiresAt?`<t:${Math.floor(v.expiresAt.getTime()/1000)}:R>`:"Never"}`).join("\n"):"No invites.").setFooter({ text:`${sorted.length} invite(s)` })], ephemeral:true });
});

reg(new SlashCommandBuilder().setName("rolemembers").setDescription("List members with a role").addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)),
  async (i) => { if (!await checkRank(i,2)) return; const r=i.options.getRole("role"), members=r.members.map(m=>`**${m.user.tag}** (${m.id})`); await i.reply({ embeds:[new EmbedBuilder().setColor(r.color||COLORS.info).setTitle(`${r.name} Members`).setDescription(members.length?members.slice(0,30).join("\n"):"No members.").setFooter({ text:`${members.length} member(s)` })], ephemeral:true }); }
);

reg(new SlashCommandBuilder().setName("cleanup").setDescription("Delete all messages from a user in this channel").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)).addIntegerOption(o=>o.setName("search").setDescription("Messages to search (max 100)").setMinValue(10).setMaxValue(100).setRequired(false)),
  async (i) => { if (!await checkRank(i,2)) return; const t=i.options.getUser("user"); await i.deferReply({ ephemeral:true }); const msgs=await i.channel.messages.fetch({ limit:i.options.getInteger("search")??100 }); const del=await i.channel.bulkDelete(msgs.filter(m=>m.author.id===t.id),true).catch(()=>null); await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Deleted **${del?.size??0}** messages from **${t.tag}**.`)] }); }
);

reg(new SlashCommandBuilder().setName("massrole").setDescription("Add/remove a role from all members").addStringOption(o=>o.setName("action").setDescription("Action").addChoices({ name:"Add",value:"add" },{ name:"Remove",value:"remove" }).setRequired(true)).addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)),
  async (i) => { if (!await checkRank(i,4)) return; const act=i.options.getString("action"), role=i.options.getRole("role"); await i.deferReply(); let count=0; for (const [,m] of i.guild.members.cache) { try { if(act==="add"&&!m.roles.cache.has(role.id)){await m.roles.add(role);count++;} else if(act==="remove"&&m.roles.cache.has(role.id)){await m.roles.remove(role);count++;} } catch {} } await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`${act==="add"?"Added":"Removed"} **${role.name}** ${act==="add"?"to":"from"} **${count}** member(s).`).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("lockdown").setDescription("Lock all text channels").addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)),
  async (i) => { if (!await checkRank(i,3)) return; await i.deferReply(); const r=i.options.getString("reason")||"Lockdown initiated"; let n=0; for (const [,ch] of i.guild.channels.cache) { if(ch.isTextBased()) { try { await ch.permissionOverwrites.edit(i.guild.roles.everyone,{ SendMessages:false },{ reason:r }); n++; } catch {} } } await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("Lockdown Active").setDescription(`**${n}** channels locked.\n**Reason:** ${r}`).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("unlockdown").setDescription("Lift server lockdown"),
  async (i) => { if (!await checkRank(i,3)) return; await i.deferReply(); let n=0; for (const [,ch] of i.guild.channels.cache) { if(ch.isTextBased()) { try { await ch.permissionOverwrites.edit(i.guild.roles.everyone,{ SendMessages:null }); n++; } catch {} } } await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Lockdown Lifted").setDescription(`**${n}** channels restored.`).setTimestamp()] }); }
);

reg(new SlashCommandBuilder().setName("panic").setDescription("EMERGENCY — lock all channels across all approved servers").addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)),
  async (i, client) => {
    if (!await checkRank(i,5)) return; await i.deferReply();
    const reason=i.options.getString("reason"); const guilds=approvedGuilds(); let total=0;
    for (const { guild_id } of guilds) { const g=client.guilds.cache.get(guild_id); if(!g) continue; for (const [,ch] of g.channels.cache) { if(ch.isTextBased()) { try { await ch.permissionOverwrites.edit(g.roles.everyone,{ SendMessages:false }); total++; } catch {} } } }
    await i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle("⚠️ PANIC MODE ACTIVE").setDescription(`**${guilds.length}** guild(s) affected.\n**${total}** channels locked.\n\n**Reason:** ${reason}\n\nUse \`/unlockdown\` in each server to restore.`).setTimestamp()] });
  }
);

reg(new SlashCommandBuilder().setName("reputation").setDescription("View a user's reputation score").addUserOption(o=>o.setName("user").setDescription("User").setRequired(false)).addStringOption(o=>o.setName("userid").setDescription("User ID").setRequired(false)),
  async (i) => { if (!await checkRank(i,1)) return; const u=i.options.getUser("user")??i.user, uid=i.options.getString("userid")??u.id, rep=db.prepare("SELECT * FROM reputation WHERE user_id=?").get(uid); if(!rep) return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setDescription(`No data for <@${uid}>.`)], ephemeral:true }); await i.reply({ embeds:[new EmbedBuilder().setColor(rep.score>=80?COLORS.success:rep.score>=50?COLORS.warning:COLORS.danger).setTitle(`Reputation — ${rep.username}`).addFields({ name:"Score",value:`${rep.score}/100`,inline:true },{ name:"Warnings",value:`${rep.warnings}`,inline:true },{ name:"Mutes",value:`${rep.mutes}`,inline:true },{ name:"Bans",value:`${rep.bans}`,inline:true },{ name:"Trusted",value:rep.trusted?"Yes":"No",inline:true },{ name:"Watchlisted",value:rep.watchlisted?"Yes":"No",inline:true }).setTimestamp()], ephemeral:true }); }
);

reg(new SlashCommandBuilder().setName("trust").setDescription("Mark user as trusted").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)),
  async (i) => { if (!await checkRank(i,3)) return; const t=i.options.getUser("user"); db.prepare("INSERT OR IGNORE INTO reputation (user_id,username) VALUES (?,?)").run(t.id,t.tag); db.prepare("UPDATE reputation SET trusted=1 WHERE user_id=?").run(t.id); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${t.id}> is now **Trusted**.`)] }); }
);

reg(new SlashCommandBuilder().setName("untrust").setDescription("Remove trusted status").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)),
  async (i) => { if (!await checkRank(i,3)) return; const t=i.options.getUser("user"); db.prepare("UPDATE reputation SET trusted=0 WHERE user_id=?").run(t.id); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setDescription(`<@${t.id}> trusted status removed.`)] }); }
);

reg(
  new SlashCommandBuilder().setName("watchlist").setDescription("Manage user watchlist")
    .addSubcommand(s=>s.setName("add").setDescription("Add to watchlist").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove from watchlist").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)))
    .addSubcommand(s=>s.setName("list").setDescription("View watchlist")),
  async (i) => {
    if (!await checkRank(i,2)) return; const sub=i.options.getSubcommand();
    if (sub==="list") { const list=db.prepare("SELECT * FROM reputation WHERE watchlisted=1").all(); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle("Watchlist").setDescription(list.length?list.map(u=>`**${u.username}** (<@${u.user_id}>) — Score: ${u.score}`).join("\n"):"Empty.")], ephemeral:true }); }
    const t=i.options.getUser("user"); db.prepare("INSERT OR IGNORE INTO reputation (user_id,username) VALUES (?,?)").run(t.id,t.tag);
    if (sub==="add") { db.prepare("UPDATE reputation SET watchlisted=1 WHERE user_id=?").run(t.id); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setDescription(`<@${t.id}> added to watchlist.`)] }); }
    db.prepare("UPDATE reputation SET watchlisted=0 WHERE user_id=?").run(t.id); await i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`<@${t.id}> removed from watchlist.`)] });
  }
);

reg(new SlashCommandBuilder().setName("securityscan").setDescription("Scan this server for security risks"), async (i) => {
  if (!await checkRank(i,3)) return; await i.deferReply();
  const g=i.guild; const risks=[]; let score=100;
  if (g.verificationLevel<2) { risks.push("Low verification level — raise to MEDIUM or higher"); score-=15; }
  if (g.mfaLevel===0) { risks.push("2FA not required for admin actions"); score-=10; }
  const adminRoles=g.roles.cache.filter(r=>r.permissions.has("Administrator"));
  if (adminRoles.size>3) { risks.push(`${adminRoles.size} roles have Administrator — reduce this`); score-=10; }
  const gBans=db.prepare("SELECT user_id FROM global_bans WHERE active=1").all().map(r=>r.user_id);
  const present=g.members.cache.filter(m=>gBans.includes(m.id));
  if (present.size>0) { risks.push(`${present.size} globally banned user(s) still in server`); score-=20; }
  await i.editReply({ embeds:[new EmbedBuilder().setColor(score>=80?COLORS.success:score>=50?COLORS.warning:COLORS.danger).setTitle(`Security Scan — ${g.name}`).addFields({ name:"Score",value:`${score}/100`,inline:true },{ name:"Risks",value:`${risks.length}`,inline:true },{ name:"Findings",value:risks.length?risks.map(r=>`• ${r}`).join("\n"):"No major risks detected." }).setTimestamp()] });
});

reg(
  new SlashCommandBuilder().setName("backup").setDescription("Server backup management")
    .addSubcommand(s=>s.setName("create").setDescription("Create a backup"))
    .addSubcommand(s=>s.setName("list").setDescription("List backups"))
    .addSubcommand(s=>s.setName("delete").setDescription("Delete a backup").addIntegerOption(o=>o.setName("id").setDescription("Backup ID").setRequired(true))),
  async (i) => {
    if (!await checkRank(i,3)) return; const sub=i.options.getSubcommand();
    if (sub==="create") { await i.deferReply({ ephemeral:true }); const g=i.guild; const data={ name:g.name, channels:g.channels.cache.map(c=>({ id:c.id,name:c.name,type:c.type,parentId:c.parentId,position:c.position })), roles:g.roles.cache.filter(r=>!r.managed).map(r=>({ id:r.id,name:r.name,color:r.color,hoist:r.hoist,position:r.position })), ts:new Date().toISOString() }; const row=db.prepare("INSERT INTO backups (guild_id,guild_name,backup_data,created_by) VALUES (?,?,?,?) RETURNING id").get(g.id,g.name,JSON.stringify(data),i.user.id); return i.editReply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("Backup Created").addFields({ name:"ID",value:`${row.id}`,inline:true },{ name:"Channels",value:`${data.channels.length}`,inline:true },{ name:"Roles",value:`${data.roles.length}`,inline:true }).setTimestamp()] }); }
    if (sub==="list") { const bkps=db.prepare("SELECT id,guild_name,created_by,created_at FROM backups WHERE guild_id=? ORDER BY created_at DESC").all(i.guildId); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setTitle("Backups").setDescription(bkps.length?bkps.map(b=>`**#${b.id}** — ${b.created_at.slice(0,16)} by <@${b.created_by}>`).join("\n"):"No backups.")], ephemeral:true }); }
    if (sub==="delete") { const id=i.options.getInteger("id"); db.prepare("DELETE FROM backups WHERE id=? AND guild_id=?").run(id,i.guildId); return i.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setDescription(`Backup **#${id}** deleted.`)], ephemeral:true }); }
  }
);

// ─── CLIENT ──────────────────────────────────────────────────────────────────
const client = new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildModeration,GatewayIntentBits.MessageContent,GatewayIntentBits.DirectMessages,GatewayIntentBits.GuildInvites],
  partials:[Partials.Channel,Partials.Message],
});

// ─── EVENTS ──────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`[TS5] Logged in as ${client.user.tag}`);
  console.log(`[TS5] ${commands.size} commands | ${client.guilds.cache.size} guilds`);
  client.user.setActivity("the network",{ type:ActivityType.Watching });
  for (const [gid,guild] of client.guilds.cache) {
    db.prepare("INSERT OR IGNORE INTO approved_guilds (guild_id,guild_name,owner_id,member_count,status) VALUES (?,?,?,?,'pending')").run(gid,guild.name,guild.ownerId,guild.memberCount);
    db.prepare("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)").run(gid);
  }
});

client.on("guildCreate", async (guild) => {
  console.log(`[TS5] Joined: ${guild.name}`);
  db.prepare("INSERT OR IGNORE INTO approved_guilds (guild_id,guild_name,owner_id,member_count,status) VALUES (?,?,?,?,'pending')").run(guild.id,guild.name,guild.ownerId,guild.memberCount);
  db.prepare("INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)").run(guild.id);
  try { const owner=await client.users.fetch(OWNER_ID); await owner.send({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle("New Guild — Pending Approval").setDescription(`**${guild.name}** added TS5.\nStatus: **PENDING**`).addFields({ name:"Guild ID",value:guild.id,inline:true },{ name:"Members",value:`${guild.memberCount}`,inline:true },{ name:"Owner",value:`<@${guild.ownerId}>`,inline:true }).setThumbnail(guild.iconURL({ dynamic:true })).setTimestamp()] }); } catch {}
});

client.on("guildMemberAdd", async (member) => {
  const s=guildSettings(member.guild.id); if (!s?.welcome_channel_id) return;
  const ch=member.guild.channels.cache.get(s.welcome_channel_id); if(!ch) return;
  const age=Math.floor((Date.now()-member.user.createdTimestamp)/(1000*60*60*24)), isNew=age<7;
  const e=new EmbedBuilder().setColor(isNew?COLORS.danger:COLORS.success).setTitle(`Welcome to ${member.guild.name}!`).setDescription(`Hey <@${member.id}>, you are the **${ordinal(member.guild.memberCount)} member**!`).setThumbnail(member.user.displayAvatarURL({ dynamic:true })).addFields({ name:"Account Age",value:`${age} day${age!==1?"s":""}`,inline:true },{ name:"Members",value:`${member.guild.memberCount}`,inline:true }).setTimestamp();
  if (isNew) e.addFields({ name:"⚠️ New Account",value:"Account created less than 7 days ago.",inline:false });
  if (member.guild.bannerURL()) e.setImage(member.guild.bannerURL({ size:1024 }));
  await ch.send({ embeds:[e] }).catch(()=>{});
});

client.on("guildMemberRemove", async (member) => {
  const e=new EmbedBuilder().setColor(COLORS.warning).setTitle("Member Left").setDescription(`**${member.user.tag}** left the server.`).addFields({ name:"User ID",value:member.id,inline:true },{ name:"Joined",value:member.joinedAt?`<t:${Math.floor(member.joinedTimestamp/1000)}:R>`:"Unknown",inline:true },{ name:"Roles",value:member.roles.cache.filter(r=>r.id!==member.guild.id).map(r=>r.name).join(", ")||"None",inline:false }).setThumbnail(member.user.displayAvatarURL({ dynamic:true })).setTimestamp();
  await eventLog(member.guild,e);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot||message.guild) return;
  const list=db.prepare("SELECT user_id FROM dm_notify").all(); if(!list.length) return;
  const e=new EmbedBuilder().setColor(COLORS.info).setTitle("New DM Received").setDescription(message.content||"_No text_").setAuthor({ name:message.author.tag,iconURL:message.author.displayAvatarURL({ dynamic:true }) }).addFields({ name:"User ID",value:message.author.id,inline:true }).setTimestamp();
  const atts=message.attachments.map(a=>a.url); if(atts.length){e.addFields({ name:"Attachments",value:atts.join("\n"),inline:false });e.setImage(atts[0]);}
  for (const { user_id } of list) { try { const u=await client.users.fetch(user_id); await u.send({ content:`<@${user_id}>`,embeds:[e] }); } catch {} }
});

client.on("messageUpdate", async (old, n) => {
  if (n.author?.bot||!n.guild||old.content===n.content) return;
  await eventLog(n.guild,new EmbedBuilder().setColor(COLORS.info).setTitle("Message Edited").setDescription(`<@${n.author?.id}> in <#${n.channelId}>`).addFields({ name:"Before",value:(old.content||"_empty_").slice(0,1024),inline:false },{ name:"After",value:(n.content||"_empty_").slice(0,1024),inline:false }).setFooter({ text:`ID: ${n.id}` }).setTimestamp());
});

client.on("messageDelete", async (message) => {
  if (message.author?.bot||!message.guild) return;
  await eventLog(message.guild,new EmbedBuilder().setColor(COLORS.danger).setTitle("Message Deleted").setDescription(`<@${message.author?.id??"Unknown"}> in <#${message.channelId}>`).addFields({ name:"Content",value:(message.content||"_empty_").slice(0,1024),inline:false }).setFooter({ text:`ID: ${message.id}` }).setTimestamp());
});

client.on("voiceStateUpdate", async (old, n) => {
  const member=n.member||old.member; if(!member||member.user.bot) return;
  let title,color;
  if (!old.channelId&&n.channelId){title=`Voice Join — <#${n.channelId}>`;color=COLORS.success;}
  else if (old.channelId&&!n.channelId){title=`Voice Leave — <#${old.channelId}>`;color=COLORS.warning;}
  else if (old.channelId!==n.channelId){title=`Voice Move — <#${old.channelId}> → <#${n.channelId}>`;color=COLORS.info;}
  else return;
  await eventLog(member.guild,new EmbedBuilder().setColor(color).setTitle(title).setDescription(`**${member.user.tag}** (${member.id})`).setTimestamp());
});

client.on("guildMemberUpdate", async (old, n) => {
  if (old.nickname!==n.nickname) await eventLog(n.guild,new EmbedBuilder().setColor(COLORS.info).setTitle("Nickname Changed").setDescription(`**${n.user.tag}**`).addFields({ name:"Before",value:old.nickname||"_None_",inline:true },{ name:"After",value:n.nickname||"_None_",inline:true }).setTimestamp());
  const added=n.roles.cache.filter(r=>!old.roles.cache.has(r.id));
  const removed=old.roles.cache.filter(r=>!n.roles.cache.has(r.id));
  if (added.size) await eventLog(n.guild,new EmbedBuilder().setColor(COLORS.success).setTitle("Role Added").setDescription(`**${n.user.tag}** got ${added.map(r=>`<@&${r.id}>`).join(", ")}`).setTimestamp());
  if (removed.size) await eventLog(n.guild,new EmbedBuilder().setColor(COLORS.danger).setTitle("Role Removed").setDescription(`**${n.user.tag}** lost ${removed.map(r=>`<@&${r.id}>`).join(", ")}`).setTimestamp());
  if (!old.premiumSince&&n.premiumSince) await eventLog(n.guild,new EmbedBuilder().setColor(0xf47fff).setTitle("Server Boosted").setDescription(`**${n.user.tag}** just boosted!`).setTimestamp());
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const cmd=commands.get(interaction.commandName); if(!cmd) return;
    try { await cmd.execute(interaction,client); }
    catch(err) { console.error(`[Error] /${interaction.commandName}:`,err); const msg={ content:"An error occurred.",ephemeral:true }; if(interaction.replied||interaction.deferred) await interaction.followUp(msg).catch(()=>{}); else await interaction.reply(msg).catch(()=>{}); }
    return;
  }
  if (interaction.isButton()) {
    const id=interaction.customId;
    if (id.startsWith("ca_")) { // approve
      const cid=parseInt(id.slice(3)), c=db.prepare("SELECT * FROM mod_cases WHERE id=?").get(cid);
      db.prepare("UPDATE mod_cases SET status='approved',reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(interaction.user.id,cid);
      await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle(`Case #${cid} Approved`).setTimestamp()], ephemeral:true });
    } else if (id.startsWith("cr_")) { // review
      const cid=parseInt(id.slice(3)); db.prepare("UPDATE mod_cases SET status='pending',reviewed_by=? WHERE id=?").run(interaction.user.id,cid);
      await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle(`Case #${cid} — Review Needed`).setTimestamp()], ephemeral:true });
    } else if (id.startsWith("cm_")) { // remind
      const cid=parseInt(id.slice(3)), c=db.prepare("SELECT * FROM mod_cases WHERE id=?").get(cid);
      if (!c) return interaction.reply({ content:"Case not found.",ephemeral:true });
      db.prepare("UPDATE mod_cases SET remind_count=remind_count+1,last_reminded=datetime('now') WHERE id=?").run(cid);
      try { const t=await client.users.fetch(c.user_id); await t.send({ embeds:[new EmbedBuilder().setColor(COLORS.warning).setTitle("Proof Reminder").setDescription(`You've been reminded to submit proof for Case **#${cid}** (${c.type.toUpperCase()}).\nPlease provide evidence to the reviewing staff.`).setTimestamp()] }); await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.info).setDescription(`Reminder sent to <@${c.user_id}>.`)], ephemeral:true }); }
      catch { await interaction.reply({ content:"Could not DM that user.",ephemeral:true }); }
    } else if (id.startsWith("cu_")) { // unglobalban
      const cid=parseInt(id.slice(3)), c=db.prepare("SELECT * FROM mod_cases WHERE id=?").get(cid);
      if (!c) return interaction.reply({ content:"Case not found.",ephemeral:true });
      db.prepare("UPDATE global_bans SET active=0 WHERE user_id=?").run(c.user_id);
      db.prepare("UPDATE mod_cases SET status='denied',reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(interaction.user.id,cid);
      for (const { guild_id } of approvedGuilds()) { const g=client.guilds.cache.get(guild_id); if(g) await g.members.unban(c.user_id).catch(()=>{}); }
      await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.success).setTitle("UnGlobalbanned").setDescription(`<@${c.user_id}> removed from global ban list.`).setTimestamp()], ephemeral:true });
    } else if (id.startsWith("cd_")) { // deny
      const cid=parseInt(id.slice(3)); db.prepare("UPDATE mod_cases SET status='denied',reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(interaction.user.id,cid);
      await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle(`Case #${cid} Denied`).setTimestamp()], ephemeral:true });
    } else if (id.startsWith("ce_")) { // escalate
      const cid=parseInt(id.slice(3)); db.prepare("UPDATE mod_cases SET status='escalated',reviewed_by=? WHERE id=?").run(interaction.user.id,cid);
      await interaction.reply({ embeds:[new EmbedBuilder().setColor(COLORS.danger).setTitle(`Case #${cid} Escalated`).setDescription("Escalated to **Network Owner** only review.").setTimestamp()], ephemeral:true });
    }
  }
});

// ─── TEMP BAN EXPIRY CRON ────────────────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  const expired=db.prepare("SELECT * FROM temp_bans WHERE active=1 AND expires_at<=datetime('now')").all();
  for (const ban of expired) {
    try { const g=client.guilds.cache.get(ban.guild_id); if(g){await g.members.unban(ban.user_id,"Temp ban expired");db.prepare("UPDATE temp_bans SET active=0 WHERE id=?").run(ban.id);console.log(`[TempBan] Unbanned ${ban.user_id} from ${g.name}`);} }
    catch(e){console.error(`[TempBan]`,e.message);}
  }
});

// ─── DEPLOY COMMANDS (auto on start if no commands registered) ───────────────
async function deployCommands() {
  const rest=new REST().setToken(TOKEN);
  const body=[...commands.values()].map(c=>c.data.toJSON());
  const route=GUILD_ID?Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID):Routes.applicationCommands(CLIENT_ID);
  await rest.put(route,{ body });
  console.log(`[TS5] Deployed ${body.length} commands${GUILD_ID?` to guild ${GUILD_ID}`:" globally"}`);
}

// ─── START ───────────────────────────────────────────────────────────────────
client.login(TOKEN).then(async () => {
  try { await deployCommands(); } catch(e) { console.error("[Deploy]",e.message); }
}).catch(err => { console.error("Login failed:",err.message); process.exit(1); });
