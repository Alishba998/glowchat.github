// server.js - GlowChat production-ready scaffold (dev-ready)
require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http, { cors: { origin: '*' }});
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const Twilio = require('twilio');

const SECRET = process.env.JWT_SECRET || 'dev_secret';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname, 'public')));

// DB: prefer Postgres if DATABASE_URL provided, else use sqlite
let pool = null;
let sqliteDb = null;
if(process.env.DATABASE_URL){
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
} else {
  const dbFile = path.join(__dirname, 'data', 'glowchat.db');
  const dbDir = path.join(__dirname, 'data');
  if(!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
  sqliteDb = new sqlite3.Database(dbFile);
}

// AWS S3 setup (for presigned uploads). For local dev, MinIO docker is provided.
let s3 = null;
if(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY){
  AWS.config.update({region: process.env.S3_REGION || 'us-east-1'});
  s3 = new AWS.S3();
}

// Twilio setup (for OTP). For demo mode, server will return OTP in response if TWILIO not configured.
let twilioClient = null;
if(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN){
  twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Multer for local uploads (used as fallback or for processing before upload to S3)
const storage = multer.diskStorage({
  destination: (req,file,cb)=> cb(null, UPLOAD_DIR),
  filename: (req,file,cb)=> cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({storage});

// Utility: run query in Postgres or sqlite
async function dbRun(sql, params=[]){
  if(pool){
    const res = await pool.query(sql, params);
    return res;
  } else {
    return new Promise((resolve,reject)=>{
      sqliteDb.run(sql, params, function(err){
        if(err) reject(err); else resolve(this);
      });
    });
  }
}
async function dbAll(sql, params=[]){
  if(pool){
    const res = await pool.query(sql, params);
    return res.rows;
  } else {
    return new Promise((resolve,reject)=>{
      sqliteDb.all(sql, params, (err,rows)=> err ? reject(err) : resolve(rows));
    });
  }
}
async function dbGet(sql, params=[]){
  if(pool){
    const res = await pool.query(sql, params);
    return res.rows[0];
  } else {
    return new Promise((resolve,reject)=>{
      sqliteDb.get(sql, params, (err,row)=> err ? reject(err) : resolve(row));
    });
  }
}

// Auth helpers
function authMiddleware(req,res,next){
  const h = req.headers.authorization;
  if(!h) return res.status(401).json({error:'noauth'});
  const parts = h.split(' ');
  if(parts.length!==2) return res.status(401).json({error:'noauth'});
  try{
    const payload = jwt.verify(parts[1], SECRET);
    req.user = payload;
    next();
  }catch(e){
    return res.status(401).json({error:'invalid'});
  }
}

// Register (email/password)
app.post('/api/register', async (req,res)=>{
  const {email,password,display_name,phone} = req.body;
  if(!email || !password) return res.status(400).json({error:'missing'});
  const hash = await bcrypt.hash(password, 10);
  const created_at = Date.now();
  if(pool){
    try{
      const r = await pool.query(`INSERT INTO users (email,password_hash,display_name,phone,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id,display_name,email`, [email,hash,display_name||email.split('@')[0],phone||null,created_at]);
      const user = r.rows[0];
      const token = jwt.sign({id:user.id,email:user.email}, SECRET);
      return res.json({token, user});
    }catch(e){ return res.status(400).json({error:e.message}); }
  } else {
    sqliteDb.run(`INSERT INTO users (email,password_hash,display_name,phone,created_at) VALUES (?,?,?,?,?)`, [email,hash,display_name||email.split('@')[0],phone||null,created_at], function(err){
      if(err) return res.status(400).json({error:err.message});
      const id = this.lastID;
      const token = jwt.sign({id,email}, SECRET);
      res.json({token, user:{id,display_name:display_name||email.split('@')[0],email}});
    });
  }
});

// Login
app.post('/api/login', async (req,res)=>{
  const {email,password} = req.body;
  if(!email || !password) return res.status(400).json({error:'missing'});
  if(pool){
    const row = await dbGet('SELECT * FROM users WHERE email=$1', [email]);
    if(!row) return res.status(401).json({error:'invalid'});
    const ok = await bcrypt.compare(password, row.password_hash);
    if(!ok) return res.status(401).json({error:'invalid'});
    const token = jwt.sign({id:row.id,email:row.email}, SECRET);
    return res.json({token, user:{id:row.id,email:row.email,display_name:row.display_name,avatar:row.avatar}});
  } else {
    sqliteDb.get(`SELECT * FROM users WHERE email=?`, [email], async (err,row)=>{
      if(err) return res.status(500).json({error:err.message});
      if(!row) return res.status(401).json({error:'invalid'});
      const ok = await bcrypt.compare(password, row.password_hash);
      if(!ok) return res.status(401).json({error:'invalid'});
      const token = jwt.sign({id:row.id,email:row.email}, SECRET);
      res.json({token, user:{id:row.id,email:row.email,display_name:row.display_name,avatar:row.avatar}});
    });
  }
});

// Twilio OTP send (demo fallback returns code)
app.post('/api/send-otp', async (req,res)=>{
  const {phone} = req.body;
  if(!phone) return res.status(400).json({error:'missing phone'});
  const code = Math.floor(100000 + Math.random()*900000).toString();
  if(twilioClient){
    try{
      await twilioClient.messages.create({from: process.env.TWILIO_PHONE_NUMBER, to: phone, body: `Your GlowChat OTP: ${code}`});
      // store code in-memory for demo; replace with DB/redis in prod
      if(!global.otp) global.otp = {};
      global.otp[phone] = {code, expires: Date.now()+5*60*1000};
      return res.json({ok:true});
    }catch(e){ return res.status(500).json({error:e.message}); }
  } else {
    // demo mode: return code in response (remove in production)
    if(!global.otp) global.otp = {};
    global.otp[phone] = {code, expires: Date.now()+5*60*1000};
    return res.json({ok:true, code});
  }
});

// Verify OTP and create/get user
app.post('/api/verify-otp', async (req,res)=>{
  const {phone,code,display_name} = req.body;
  if(!phone || !code) return res.status(400).json({error:'missing'});
  const rec = global.otp && global.otp[phone];
  if(!rec || rec.code !== code) return res.status(401).json({error:'invalid code'});
  // find or create user by phone
  if(pool){
    let user = await dbGet('SELECT * FROM users WHERE phone=$1', [phone]);
    if(!user){
      const r = await pool.query('INSERT INTO users (phone,display_name,created_at) VALUES ($1,$2,$3) RETURNING id,display_name,phone', [phone,display_name||phone,Date.now()]);
      user = r.rows[0];
    }
    const token = jwt.sign({id:user.id,phone}, SECRET);
    return res.json({token, user});
  } else {
    sqliteDb.get(`SELECT * FROM users WHERE phone=?`, [phone], (err,row)=>{
      if(row){
        const token = jwt.sign({id:row.id,phone}, SECRET);
        return res.json({token, user:{id:row.id,display_name:row.display_name,phone:row.phone}});
      } else {
        sqliteDb.run(`INSERT INTO users (phone,display_name,created_at) VALUES (?,?,?)`, [phone,display_name||phone,Date.now()], function(err){
          if(err) return res.status(500).json({error:err.message});
          const id = this.lastID;
          const token = jwt.sign({id,phone}, SECRET);
          return res.json({token, user:{id,display_name:display_name||phone}});
        });
      }
    });
  }
});

// S3 presigned upload endpoint (for stories/media)
app.post('/api/presign', authMiddleware, async (req,res)=>{
  const {filename, contentType} = req.body;
  if(!filename || !contentType) return res.status(400).json({error:'missing'});
  const key = `uploads/${Date.now()}-${filename.replace(/\s+/g,'_')}`;
  if(s3){
    const params = {Bucket: process.env.S3_BUCKET, Key: key, ContentType: contentType, ACL: 'public-read'};
    try{
      const presigned = await s3.getSignedUrlPromise('putObject', params);
      return res.json({ok:true, url: presigned, key, publicUrl: `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`});
    }catch(e){ return res.status(500).json({error:e.message}); }
  } else {
    // fallback: accept direct upload to local server
    return res.json({ok:true, fallback:true, uploadUrl:'/upload-local', key});
  }
});

// local upload endpoint (fallback; used by presign fallback)
app.post('/upload-local', authMiddleware, upload.single('file'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'no file'});
  // store story record in DB
  const created_at = Date.now();
  const expires = created_at + 24*60*60*1000;
  const filename = req.file.filename;
  (async ()=> {
    if(pool){
      await pool.query('INSERT INTO stories (uploader_id,filename,created_at,expires_at) VALUES ($1,$2,$3,$4)', [req.user.id, filename, created_at, expires]);
    } else {
      sqliteDb.run('INSERT INTO stories (uploader_id,filename,created_at,expires_at) VALUES (?,?,?,?)', [req.user.id, filename, created_at, expires]);
    }
    io.emit('stories:update', {uploader_id: req.user.id, filename, created_at, expires});
    res.json({ok:true, filename});
  })();
});

// Serve uploads (fallback)
app.get('/uploads/:name', (req,res)=>{
  const file = path.join(UPLOAD_DIR, req.params.name);
  if(fs.existsSync(file)) return res.sendFile(file);
  res.status(404).end();
});

// Chat endpoints (create, list, send message, persist)
app.post('/api/chats', authMiddleware, async (req,res)=>{
  const {title,type,member_ids,locked,pin} = req.body;
  const created_at = Date.now();
  if(pool){
    const r = await pool.query('INSERT INTO chats (title,type,owner_id,locked,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [title||'Chat', type||'group', req.user.id, locked?true:false, created_at]);
    const chatId = r.rows[0].id;
    await pool.query('INSERT INTO chat_members (chat_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [chatId, req.user.id, 'owner', created_at]);
    if(Array.isArray(member_ids)){
      for(const uid of member_ids) await pool.query('INSERT INTO chat_members (chat_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [chatId, uid, 'member', created_at]);
    }
    return res.json({ok:true, chatId});
  } else {
    sqliteDb.run('INSERT INTO chats (title,type,owner_id,locked,created_at) VALUES (?,?,?,?,?)', [title||'Chat', type||'group', req.user.id, locked?1:0, created_at], function(err){
      if(err) return res.status(500).json({error:err.message});
      const chatId = this.lastID;
      sqliteDb.run('INSERT INTO chat_members (chat_id,user_id,role,joined_at) VALUES (?,?,?,?)', [chatId, req.user.id, 'owner', created_at]);
      return res.json({ok:true, chatId});
    });
  }
});

// send message (persist + broadcast)
app.post('/api/chats/:id/messages', authMiddleware, async (req,res)=>{
  const chatId = req.params.id;
  const {text} = req.body;
  const created_at = Date.now();
  if(pool){
    const r = await pool.query('INSERT INTO messages (chat_id,sender_id,content,created_at) VALUES ($1,$2,$3,$4) RETURNING id', [chatId, req.user.id, text, created_at]);
    const msgId = r.rows[0].id;
    const user = await dbGet('SELECT display_name FROM users WHERE id=$1', [req.user.id]);
    const msg = {id:msgId, chat_id:chatId, sender_id:req.user.id, content:text, created_at, sender_name: user ? user.display_name : 'anon'};
    io.to('chat_'+chatId).emit('message:new', msg);
    return res.json({ok:true, msg});
  } else {
    sqliteDb.run('INSERT INTO messages (chat_id,sender_id,content,created_at) VALUES (?,?,?,?)', [chatId, req.user.id, text, created_at], function(err){
      if(err) return res.status(500).json({error:err.message});
      const id = this.lastID;
      sqliteDb.get('SELECT display_name FROM users WHERE id=?', [req.user.id], (err,row)=> {
        const msg = {id, chat_id:chatId, sender_id: req.user.id, content: text, created_at, sender_name: row ? row.display_name : 'anon'};
        io.to('chat_'+chatId).emit('message:new', msg);
        return res.json({ok:true, msg});
      });
    });
  }
});

// Socket.IO join and signaling
io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);
  socket.on('join', (data)=> {
    try{
      const payload = jwt.verify(data.token, process.env.JWT_SECRET || 'dev_secret');
      socket.join('user_' + payload.id);
      if(data.chatId) socket.join('chat_' + data.chatId);
    }catch(e){}
  });
  socket.on('signal', (payload)=> {
    // simple signaling: {to, type, data}
    io.to(payload.to).emit('signal', payload);
  });
});

// Admin stats (example)
app.get('/api/admin/stats', authMiddleware, async (req,res)=>{
  if(pool){
    const u = await dbAll('SELECT COUNT(*) as cnt FROM users'); const m = await dbAll('SELECT COUNT(*) as cnt FROM messages'); const s = await dbAll('SELECT COUNT(*) as cnt FROM stories');
    return res.json({users: u[0].cnt, messages: m[0].cnt, stories: s[0].cnt});
  } else {
    const users = await dbAll('SELECT COUNT(*) as cnt FROM users'); const messages = await dbAll('SELECT COUNT(*) as cnt FROM messages'); const stories = await dbAll('SELECT COUNT(*) as cnt FROM stories');
    return res.json({users: users[0]['cnt'], messages: messages[0]['cnt'], stories: stories[0]['cnt']});
  }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, ()=> console.log('GlowChat production-ready server running on', PORT));
