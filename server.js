require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt');
const path = require('path');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://askpeal121:<YOUR_PASSWORD>@cluster0.teofx.mongodb.net/mealPlanner?retryWrites=true&w=majority';
const SESSION_SECRET = process.env.SESSION_SECRET || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

// Validate environment variables
if (!MONGODB_URI.includes('<YOUR_PASSWORD>') && !process.env.MONGODB_URI) {
  console.error('FATAL: MONGODB_URI is not set properly. Set it in environment variables.');
  process.exit(1);
}
if (SESSION_SECRET === 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: Using default SESSION_SECRET. Set a secure secret in production.');
}

// MongoDB Connection
async function connectMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log(`MongoDB connected at ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}`);
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
}
connectMongoDB();

// Middleware Setup
app.set('trust proxy', 1); // Trust Render's proxy
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  message: { error: 'Too many requests. Try again later.' },
}));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions',
    ttl: 24 * 60 * 60, // 24 hours
  }).on('error', (err) => console.error('MongoStore error:', err.message)),
  cookie: {
    secure: process.env.RENDER === 'true' || process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Authentication Middleware
const requireLogin = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized: Please log in' });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized: Admin access required' });
  }
  next();
};

const requireStaff = (req, res, next) => {
  if (!req.session.staff) {
    return res.status(401).json({ error: 'Unauthorized: Staff access required' });
  }
  next();
};

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  classRoll: { type: Number, required: true, min: 1, max: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  gender: { type: String, enum: ['Male', 'Female'], required: true },
  batch: { type: String, enum: ['09', '10', '11', '12', '13'], required: true },
  deposit: { type: Number, default: 0, min: 0 },
  totalMealCount: { type: Number, default: 0, min: 0 },
}, { collection: 'users' });

const mealHistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: Date, required: true },
  meal: { type: String, enum: ['Lunch', 'Dinner', 'Both', 'Off'], required: true },
  additionalItems: [{ type: String, trim: true }],
  lunchServed: { type: Boolean, default: false },
  dinnerServed: { type: Boolean, default: false },
  dailyMealCount: { type: Number, default: 0, min: 0 },
  isExtra: { type: Boolean, default: false },
}, { collection: 'mealhistories' });

const staffSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  isActive: { type: Boolean, default: true },
}, { collection: 'staff' });

const adminSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
}, { collection: 'admins' });

const depositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  requestDate: { type: Date, default: Date.now },
}, { collection: 'deposits' });

userSchema.index({ classRoll: 1, batch: 1 }, { unique: true });
mealHistorySchema.index({ userId: 1, date: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const MealHistory = mongoose.model('MealHistory', mealHistorySchema);
const Staff = mongoose.model('Staff', staffSchema);
const Admin = mongoose.model('Admin', adminSchema);
const Deposit = mongoose.model('Deposit', depositSchema);

// Cron Job: Daily meal count update at midnight Asia/Dhaka
cron.schedule('0 0 * * *', async () => {
  try {
    console.log(`Running daily meal update at ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const users = await User.find().lean();
    for (const user of users) {
      let mealHistory = await MealHistory.findOne({ userId: user._id, date: today }).lean();
      let newMealCount = 0;
      if (!mealHistory) {
        const previousMeal = await MealHistory.findOne({ userId: user._id, date: yesterday }).lean();
        newMealCount = previousMeal ? (previousMeal.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(previousMeal.meal) ? 1 : 0) : 0;
        mealHistory = await new MealHistory({
          userId: user._id,
          date: today,
          meal: previousMeal?.meal || 'Off',
          additionalItems: previousMeal?.additionalItems || [],
          dailyMealCount: newMealCount,
          lunchServed: false,
          dinnerServed: false,
        }).save();
        await User.updateOne({ _id: user._id }, { $inc: { totalMealCount: newMealCount } });
      } else {
        newMealCount = mealHistory.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(mealHistory.meal) ? 1 : 0;
        const oldMealCount = mealHistory.dailyMealCount || 0;
        await MealHistory.updateOne({ _id: mealHistory._id }, { dailyMealCount: newMealCount });
        if (newMealCount !== oldMealCount) {
          await User.updateOne({ _id: user._id }, { $inc: { totalMealCount: newMealCount - oldMealCount } });
        }
      }
    }
    console.log('Daily meal update completed');
  } catch (error) {
    console.error('Cron job error:', error.message);
  }
}, { scheduled: true, timezone: 'Asia/Dhaka' });

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/staff/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff-login.html'));
});

app.get('/meal-update', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meal-update.html'));
});

app.get('/meal-update.html', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meal-update.html'));
});

app.get('/meal-dashboard', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({
      name: user.name,
      classRoll: user.classRoll,
      batch: user.batch,
      gender: user.gender,
      totalMealCount: user.totalMealCount,
      deposit: user.deposit,
    });
  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/meal-dashboard.html', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'meal-dashboard.html'));
});

app.get('/api/meal-history', requireLogin, async (req, res) => {
  try {
    const mealHistories = await MealHistory.find({ userId: req.session.userId }).sort({ date: -1 }).lean();
    res.json(mealHistories);
  } catch (error) {
    console.error('Meal history error:', error.message);
    res.status(500).json({ error: 'Failed to fetch meal history' });
  }
});

app.get('/api/meal-history/admin', requireAdmin, async (req, res) => {
  try {
    const { batch, gender, date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date parameter is required' });
    const selectedDate = new Date(date);
    if (isNaN(selectedDate.getTime())) return res.status(400).json({ error: 'Invalid date format' });
    selectedDate.setHours(0, 0, 0, 0);
    let query = {};
    if (batch && batch !== 'all') query.batch = batch;
    if (gender && gender !== 'all') query.gender = gender;
    const users = await User.find(query).sort({ batch: 1, classRoll: 1 }).lean();
    if (!users.length) return res.status(404).json({ error: 'No users found' });
    const mealHistories = await MealHistory.find({
      userId: { $in: users.map(u => u._id) },
      date: selectedDate,
    }).lean();
    let totalLunch = 0, totalDinner = 0, totalDailyMealCount = 0, totalMealsSum = 0;
    const additionalItemsCount = {};
    const userData = users.map(user => {
      const mealHistory = mealHistories.find(mh => mh.userId.toString() === user._id.toString()) || {
        meal: 'Off', additionalItems: [], lunchServed: false, dinnerServed: false, dailyMealCount: 0,
      };
      totalMealsSum += user.totalMealCount || 0;
      totalLunch += mealHistory.lunchServed ? 1 : 0;
      totalDinner += mealHistory.dinnerServed ? 1 : 0;
      totalDailyMealCount += mealHistory.dailyMealCount || 0;
      mealHistory.additionalItems.forEach(item => {
        additionalItemsCount[item] = (additionalItemsCount[item] || 0) + 1;
      });
      return {
        classRoll: user.classRoll,
        name: user.name,
        meal: mealHistory.meal,
        additionalItems: mealHistory.additionalItems.join(', ') || '-',
        lunchServed: mealHistory.lunchServed,
        dinnerServed: mealHistory.dinnerServed,
        dailyMealCount: mealHistory.dailyMealCount || 0,
        totalMealCount: user.totalMealCount || 0,
      };
    });
    const additionalItemsSummary = Object.entries(additionalItemsCount)
      .map(([item, count]) => `${item}: ${count}`)
      .join(', ') || '-';
    res.json({
      users: userData,
      date: selectedDate.toLocaleDateString('en-GB'),
      totals: {
        lunchServed: totalLunch,
        dinnerServed: totalDinner,
        dailyMealCount: totalDailyMealCount,
        totalMeals: totalMealsSum,
        additionalItems: additionalItemsSummary,
      },
    });
  } catch (error) {
    console.error('Admin meal history API error:', error.message);
    res.status(500).json({ error: 'Error fetching meal history' });
  }
});

app.get('/create-admin', async (req, res) => {
  try {
    if (await Admin.findOne({ email: 'admin@example.com' }).lean()) {
      return res.status(400).send('Admin already exists');
    }
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await new Admin({ email: 'admin@example.com', password: hashedPassword }).save();
    res.send('Admin created successfully');
  } catch (error) {
    console.error('Create admin error:', error.message);
    res.status(500).send('Failed to create admin');
  }
});

app.get('/create-staff', async (req, res) => {
  try {
    if (await Staff.findOne({ email: 'staff@example.com' }).lean()) {
      return res.status(400).send('Staff already exists');
    }
    const hashedPassword = await bcrypt.hash('staff123', 10);
    await new Staff({ email: 'staff@example.com', password: hashedPassword }).save();
    res.send('Staff created successfully');
  } catch (error) {
    console.error('Create staff error:', error.message);
    res.status(500).send('Failed to create staff');
  }
});

app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) return res.status(400).send('Email and password required');
    const admin = await Admin.findOne({ email }).lean();
    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.status(401).send('Invalid credentials');
    }
    req.session.admin = true;
    await req.session.save();
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Admin login error:', error.message);
    res.status(500).send('Server error');
  }
});

app.post('/staff/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) return res.status(400).send('Email and password required');
    const staff = await Staff.findOne({ email }).lean();
    if (!staff || !(await bcrypt.compare(password, staff.password))) {
      return res.status(401).send('Invalid credentials');
    }
    req.session.staff = true;
    await req.session.save();
    res.redirect('/staff/serving');
  } catch (error) {
    console.error('Staff login error:', error.message);
    res.status(500).send('Server error');
  }
});

app.post('/signup', async (req, res) => {
  const { name, classRoll, email, password, gender, batch } = req.body;
  try {
    if (!name || !classRoll || !email || !password || !gender || !batch) {
      return res.status(400).send('All fields required');
    }
    if (await User.findOne({ email }).lean()) return res.status(400).send('User already exists');
    if (!['09', '10', '11', '12', '13'].includes(batch)) return res.status(400).send('Invalid batch');
    if (!['Male', 'Female'].includes(gender)) return res.status(400).send('Invalid gender');
    if (classRoll < 1 || classRoll > 100) return res.status(400).send('Invalid class roll');
    if (await User.findOne({ classRoll, batch }).lean()) return res.status(400).send('Class roll exists for this batch');
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await new User({ name, classRoll, email, password: hashedPassword, gender, batch }).save();
    req.session.userId = user._id.toString();
    await req.session.save();
    res.redirect('/meal-dashboard.html');
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).send('Error signing up');
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) return res.status(400).send('Email and password required');
    const user = await User.findOne({ email }).lean();
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).send('Invalid credentials');
    }
    req.session.userId = user._id.toString();
    await req.session.save();
    res.redirect('/meal-dashboard.html');
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).send('Error logging in');
  }
});

app.post('/meal-update', requireLogin, async (req, res) => {
  const { meal, additionalItems, date } = req.body;
  try {
    if (!['Lunch', 'Dinner', 'Both', 'Off'].includes(meal)) return res.status(400).json({ error: 'Invalid meal type' });
    if (!date) return res.status(400).json({ error: 'Date required' });
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    if (new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000 - 1) < new Date()) {
      return res.status(400).json({ error: 'Cannot update past date' });
    }
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(401).json({ error: 'User not found' });
    const additionalItemsArray = Array.isArray(additionalItems) ? additionalItems.filter(Boolean) : [additionalItems].filter(Boolean);
    let mealHistory = await MealHistory.findOne({ userId: req.session.userId, date: selectedDate }).lean();
    const newMealCount = meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(meal) ? 1 : 0;
    if (mealHistory) {
      const oldMealCount = mealHistory.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(mealHistory.meal) ? 1 : 0;
      await MealHistory.updateOne({ _id: mealHistory._id }, {
        meal,
        additionalItems: additionalItemsArray,
        dailyMealCount: newMealCount,
        lunchServed: ['Both', 'Lunch'].includes(meal) ? mealHistory.lunchServed : false,
        dinnerServed: ['Both', 'Dinner'].includes(meal) ? mealHistory.dinnerServed : false,
      });
      await User.updateOne({ _id: req.session.userId }, { $inc: { totalMealCount: newMealCount - oldMealCount } });
    } else {
      await new MealHistory({
        userId: req.session.userId,
        date: selectedDate,
        meal,
        additionalItems: additionalItemsArray,
        dailyMealCount: newMealCount,
        lunchServed: false,
        dinnerServed: false,
      }).save();
      await User.updateOne({ _id: req.session.userId }, { $inc: { totalMealCount: newMealCount } });
    }
    res.json({ message: 'Meal updated successfully' });
  } catch (error) {
    console.error('Meal update error:', error.message);
    res.status(500).json({ error: 'Failed to update meal' });
  }
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const { batch, gender } = req.query;
  try {
    let query = {};
    if (batch && batch !== 'all') query.batch = batch;
    if (gender && gender !== 'all') query.gender = gender;
    const users = await User.find(query).sort({ batch: 1, classRoll: 1 }).lean();
    res.render('admin-dashboard', {
      users,
      batches: ['09', '10', '11', '12', '13'],
      genders: ['Male', 'Female'],
      selectedBatch: batch || 'all',
      selectedGender: gender || 'all',
    });
  } catch (error) {
    console.error('Admin dashboard error:', error.message);
    res.status(500).send('Server error');
  }
});

app.get('/staff/serving', requireStaff, async (req, res) => {
  const { batch, gender, date } = req.query;
  try {
    let query = {};
    if (batch && batch !== 'all') query.batch = batch;
    if (gender && gender !== 'all') query.gender = gender;
    let users = await User.find(query).sort({ batch: 1, classRoll: 1 }).lean();
    if (!users.length && Object.keys(query).length) {
      users = await User.find().sort({ batch: 1, classRoll: 1 }).lean();
    }
    const selectedDate = date ? new Date(date) : new Date();
    selectedDate.setHours(0, 0, 0, 0);
    let mealHistories = await MealHistory.find({ date: selectedDate }).lean();
    if (mealHistories.length < users.length) {
      for (const user of users) {
        if (!mealHistories.find(mh => mh.userId.toString() === user._id.toString())) {
          const previousMeal = await MealHistory.findOne({ userId: user._id, date: { $lt: selectedDate } }).sort({ date: -1 }).lean();
          const newMealCount = previousMeal ? (previousMeal.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(previousMeal.meal) ? 1 : 0) : 0;
          await new MealHistory({
            userId: user._id,
            date: selectedDate,
            meal: previousMeal?.meal || 'Off',
            additionalItems: previousMeal?.additionalItems || [],
            dailyMealCount: newMealCount,
            lunchServed: false,
            dinnerServed: false,
          }).save();
          await User.updateOne({ _id: user._id }, { $inc: { totalMealCount: newMealCount } });
        }
      }
      mealHistories = await MealHistory.find({ date: selectedDate }).lean();
    }
    res.render('staff-serving', {
      users,
      mealHistories,
      batches: ['09', '10', '11', '12', '13'],
      genders: ['Male', 'Female'],
      selectedBatch: batch || 'all',
      selectedGender: gender || 'all',
      selectedDate: selectedDate.toISOString().split('T')[0],
      isEditable: true,
      error: !users.length ? 'No users found' : null,
    });
  } catch (error) {
    console.error('Staff serving error:', error.message);
    res.status(500).render('staff-serving', {
      users: [],
      mealHistories: [],
      batches: ['09', '10', '11', '12', '13'],
      genders: ['Male', 'Female'],
      selectedBatch: batch || 'all',
      selectedGender: gender || 'all',
      selectedDate: new Date().toISOString().split('T')[0],
      isEditable: true,
      error: 'Failed to load data',
    });
  }
});

app.post('/api/meal/serve/:userId', requireStaff, async (req, res) => {
  const { userId } = req.params;
  const { mealType, date } = req.body;
  try {
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ error: 'Invalid user ID' });
    if (!['Lunch', 'Dinner'].includes(mealType)) return res.status(400).json({ error: 'Invalid meal type' });
    const selectedDate = new Date(date);
    if (isNaN(selectedDate.getTime())) return res.status(400).json({ error: 'Invalid date format' });
    selectedDate.setHours(0, 0, 0, 0);
    let mealHistory = await MealHistory.findOne({ userId, date: selectedDate }).lean();
    if (!mealHistory) {
      const user = await User.findById(userId).lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      const previousMeal = await MealHistory.findOne({ userId, date: { $lt: selectedDate } }).sort({ date: -1 }).lean();
      const newMealCount = previousMeal ? (previousMeal.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(previousMeal.meal) ? 1 : 0) : 0;
      mealHistory = await new MealHistory({
        userId,
        date: selectedDate,
        meal: previousMeal?.meal || 'Off',
        additionalItems: previousMeal?.additionalItems || [],
        dailyMealCount: newMealCount,
        lunchServed: false,
        dinnerServed: false,
      }).save();
      await User.updateOne({ _id: userId }, { $inc: { totalMealCount: newMealCount } });
    }
    if (mealHistory.meal === 'Off') return res.status(400).json({ error: 'Cannot serve meal for Off status' });
    if ((mealType === 'Lunch' && mealHistory.lunchServed) || (mealType === 'Dinner' && mealHistory.dinnerServed)) {
      return res.status(400).json({ error: `${mealType} already served` });
    }
    if (mealType === 'Lunch' && !['Lunch', 'Both'].includes(mealHistory.meal)) {
      return res.status(400).json({ error: 'Lunch not enabled' });
    }
    if (mealType === 'Dinner' && !['Dinner', 'Both'].includes(mealHistory.meal)) {
      return res.status(400).json({ error: 'Dinner not enabled' });
    }
    await MealHistory.updateOne({ _id: mealHistory._id }, {
      [mealType === 'Lunch' ? 'lunchServed' : 'dinnerServed']: true,
    });
    res.json({ message: `${mealType} served successfully` });
  } catch (error) {
    console.error('Serve meal error:', error.message);
    res.status(500).json({ error: 'Failed to serve meal' });
  }
});

app.post('/api/meal/extra', requireStaff, async (req, res) => {
  const { date, mealType } = req.body;
  try {
    if (!['Lunch', 'Dinner', 'Both'].includes(mealType)) return res.status(400).json({ error: 'Invalid meal type' });
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    const updated = await MealHistory.updateMany({ date: selectedDate, meal: 'Off' }, {
      meal: mealType,
      lunchServed: false,
      dinnerServed: false,
      dailyMealCount: mealType === 'Both' ? 2 : 1,
      isExtra: true,
    });
    if (updated.modifiedCount > 0) {
      const userIds = (await MealHistory.find({ date: selectedDate, meal: mealType }).lean()).map(m => m.userId);
      await User.updateMany({ _id: { $in: userIds } }, { $inc: { totalMealCount: mealType === 'Both' ? 2 : 1 } });
    }
    res.json({ message: `Extra ${mealType} enabled for ${updated.modifiedCount} users` });
  } catch (error) {
    console.error('Extra meal error:', error.message);
    res.status(500).json({ error: 'Failed to enable extra meals' });
  }
});

app.post('/api/meal/extra-specific', requireStaff, async (req, res) => {
  const { userId, mealType, date } = req.body;
  try {
    if (!['Lunch', 'Dinner'].includes(mealType)) return res.status(400).json({ error: 'Invalid meal type' });
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    let mealHistory = await MealHistory.findOne({ userId, date: selectedDate }).lean();
    if (!mealHistory) {
      const user = await User.findById(userId).lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      mealHistory = await new MealHistory({
        userId,
        date: selectedDate,
        meal: 'Off',
        additionalItems: [],
        dailyMealCount: 0,
        lunchServed: false,
        dinnerServed: false,
      }).save();
    }
    let newMeal, newMealCount;
    if (mealHistory.meal === 'Off') {
      newMeal = mealType;
      newMealCount = 1;
    } else if ((mealHistory.meal === 'Lunch' && mealType === 'Dinner') || (mealHistory.meal === 'Dinner' && mealType === 'Lunch')) {
      newMeal = 'Both';
      newMealCount = 2;
    } else {
      return res.status(400).json({ error: `${mealType} already enabled` });
    }
    const oldMealCount = mealHistory.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(mealHistory.meal) ? 1 : 0;
    await MealHistory.updateOne({ _id: mealHistory._id }, {
      meal: newMeal,
      dailyMealCount: newMealCount,
      lunchServed: ['Both', 'Lunch'].includes(newMeal) ? mealHistory.lunchServed : false,
      dinnerServed: ['Both', 'Dinner'].includes(newMeal) ? mealHistory.dinnerServed : false,
      isExtra: true,
    });
    await User.updateOne({ _id: userId }, { $inc: { totalMealCount: newMealCount - oldMealCount } });
    res.json({ message: `Extra ${mealType} enabled` });
  } catch (error) {
    console.error('Specific extra meal error:', error.message);
    res.status(500).json({ error: 'Failed to enable extra meal' });
  }
});

app.get('/api/meal/all-users', requireStaff, async (req, res) => {
  const { date, batch, gender } = req.query;
  try {
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    let query = {};
    if (batch && batch !== 'all') query.batch = batch;
    if (gender && gender !== 'all') query.gender = gender;
    const users = await User.find(query).lean();
    const mealHistories = await MealHistory.find({ date: selectedDate }).lean();
    const offUsers = users.map(user => {
      const mealHistory = mealHistories.find(mh => mh.userId.toString() === user._id.toString()) || {
        meal: 'Off', lunchServed: false, dinnerServed: false,
      };
      const offMeals = [];
      if (mealHistory.meal === 'Off') offMeals.push('Lunch', 'Dinner');
      else if (mealHistory.meal === 'Lunch' && !mealHistory.lunchServed) offMeals.push('Dinner');
      else if (mealHistory.meal === 'Dinner' && !mealHistory.dinnerServed) offMeals.push('Lunch');
      else if (mealHistory.meal === 'Both' && !mealHistory.lunchServed) offMeals.push('Lunch');
      else if (mealHistory.meal === 'Both' && !mealHistory.dinnerServed) offMeals.push('Dinner');
      return offMeals.length ? { _id: user._id, name: user.name, classRoll: user.classRoll, offMeals } : null;
    }).filter(Boolean);
    res.json(offUsers);
  } catch (error) {
    console.error('Fetch users error:', error.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/meal/total-count', requireStaff, async (req, res) => {
  const { date } = req.query;
  try {
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    const mealHistories = await MealHistory.find({ date: selectedDate }).lean();
    const totalCount = mealHistories.reduce((sum, mh) => sum + mh.dailyMealCount, 0);
    res.json({ totalCount });
  } catch (error) {
    console.error('Total meal count error:', error.message);
    res.status(500).json({ error: 'Failed to fetch total meal count' });
  }
});

app.post('/api/meal/staff-update', requireStaff, async (req, res) => {
  const { userId, meal, date } = req.body;
  try {
    if (!['Lunch', 'Dinner', 'Both', 'Off'].includes(meal)) return res.status(400).json({ error: 'Invalid meal type' });
    if (!date || !userId) return res.status(400).json({ error: 'Date and userId required' });
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    const user = await User.findById(userId).lean();
    if (!user) return res.status(401).json({ error: 'User not found' });
    let mealHistory = await MealHistory.findOne({ userId, date: selectedDate }).lean();
    const newMealCount = meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(meal) ? 1 : 0;
    if (mealHistory) {
      const oldMealCount = mealHistory.meal === 'Both' ? 2 : ['Lunch', 'Dinner'].includes(mealHistory.meal) ? 1 : 0;
      await MealHistory.updateOne({ _id: mealHistory._id }, {
        meal,
        dailyMealCount: newMealCount,
        lunchServed: ['Both', 'Lunch'].includes(meal) ? mealHistory.lunchServed : false,
        dinnerServed: ['Both', 'Dinner'].includes(meal) ? mealHistory.dinnerServed : false,
      });
      await User.updateOne({ _id: userId }, { $inc: { totalMealCount: newMealCount - oldMealCount } });
    } else {
      await new MealHistory({
        userId,
        date: selectedDate,
        meal,
        additionalItems: [],
        dailyMealCount: newMealCount,
        lunchServed: false,
        dinnerServed: false,
      }).save();
      await User.updateOne({ _id: userId }, { $inc: { totalMealCount: newMealCount } });
    }
    res.json({ message: 'Meal updated successfully' });
  } catch (error) {
    console.error('Staff meal update error:', error.message);
    res.status(500).json({ error: 'Failed to update meal' });
  }
});

app.post('/api/users/:id/update', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { deposit, totalMealCount } = req.body;
  try {
    const updates = {};
    if (deposit !== undefined) updates.deposit = Number(deposit);
    if (totalMealCount !== undefined) updates.totalMealCount = Number(totalMealCount);
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updates provided' });
    await User.updateOne({ _id: id }, { $set: updates });
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('User update error:', error.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ batch: 1, classRoll: 1 }).lean();
    res.json(users);
  } catch (error) {
    console.error('Fetch users error:', error.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { name, classRoll, email, password, gender, batch } = req.body;
  try {
    if (!name || !classRoll || !email || !password || !gender || !batch) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (await User.findOne({ email }).lean()) return res.status(400).json({ error: 'User already exists' });
    if (!['09', '10', '11', '12', '13'].includes(batch)) return res.status(400).json({ error: 'Invalid batch' });
    if (!['Male', 'Female'].includes(gender)) return res.status(400).json({ error: 'Invalid gender' });
    if (classRoll < 1 || classRoll > 100) return res.status(400).json({ error: 'Invalid class roll' });
    if (await User.findOne({ classRoll, batch }).lean()) return res.status(400).json({ error: 'Class roll exists for this batch' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await new User({ name, classRoll, email, password: hashedPassword, gender, batch }).save();
    res.json({ message: 'User added successfully' });
  } catch (error) {
    console.error('Add user error:', error.message);
    res.status(500).json({ error: 'Failed to add user' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid user ID' });
    const user = await User.findById(id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    await User.deleteOne({ _id: id });
    await MealHistory.deleteMany({ userId: id });
    await Deposit.deleteMany({ userId: id });
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/admin/staff', requireAdmin, async (req, res) => {
  try {
    const staff = await Staff.find().lean();
    res.json({ staff });
  } catch (error) {
    console.error('Fetch staff error:', error.message);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  const { name, email, password } = req.body;
  try {
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (await Staff.findOne({ email }).lean()) return res.status(400).json({ error: 'Staff already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await new Staff({ email, password: hashedPassword }).save();
    res.json({ message: 'Staff added successfully' });
  } catch (error) {
    console.error('Add staff error:', error.message);
    res.status(500).json({ error: 'Failed to add staff' });
  }
});

app.put('/api/admin/staff/:id/toggle-status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid staff ID' });
    const staff = await Staff.findById(id).lean();
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    await Staff.updateOne({ _id: id }, { isActive: !staff.isActive });
    res.json({ message: `Staff ${staff.isActive ? 'deactivated' : 'activated'} successfully` });
  } catch (error) {
    console.error('Toggle staff status error:', error.message);
    res.status(500).json({ error: 'Failed to toggle staff status' });
  }
});

app.delete('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid staff ID' });
    const staff = await Staff.findById(id).lean();
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    await Staff.deleteOne({ _id: id });
    res.json({ message: 'Staff deleted successfully' });
  } catch (error) {
    console.error('Delete staff error:', error.message);
    res.status(500).json({ error: 'Failed to delete staff' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const deposits = await Deposit.find().populate('userId', 'name classRoll').lean();
    res.json({ deposits });
  } catch (error) {
    console.error('Fetch deposits error:', error.message);
    res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid deposit ID' });
    const deposit = await Deposit.findById(id).lean();
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status !== 'Pending') return res.status(400).json({ error: 'Deposit already processed' });
    await Deposit.updateOne({ _id: id }, { status: 'Approved' });
    await User.updateOne({ _id: deposit.userId }, { $inc: { deposit: deposit.amount } });
    res.json({ message: 'Deposit approved successfully' });
  } catch (error) {
    console.error('Approve deposit error:', error.message);
    res.status(500).json({ error: 'Failed to approve deposit' });
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid deposit ID' });
    const deposit = await Deposit.findById(id).lean();
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status !== 'Pending') return res.status(400).json({ error: 'Deposit already processed' });
    await Deposit.updateOne({ _id: id }, { status: 'Rejected' });
    res.json({ message: 'Deposit rejected successfully' });
  } catch (error) {
    console.error('Reject deposit error:', error.message);
    res.status(500).json({ error: 'Failed to reject deposit' });
  }
});

app.get('/export-excel', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(404).send('User not found');
    const { date } = req.query;
    const selectedDate = date ? new Date(date) : new Date();
    selectedDate.setHours(0, 0, 0, 0);
    const users = await User.find({ batch: user.batch, gender: user.gender }).sort({ classRoll: 1 }).lean();
    if (!users.length) return res.status(404).send('No users found');
    const mealHistories = await MealHistory.find({
      userId: { $in: users.map(u => u._id) },
      date: selectedDate,
    }).lean();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`MUL-B${user.batch}-${user.gender.charAt(0)}`);
    worksheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 7 }];
    worksheet.properties.defaultRowHeight = 20;
    worksheet.mergeCells('A1:H1');
    worksheet.getCell('A1').value = 'Satkhira Medical College';
    worksheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getCell('A1').fill = {
      type: 'gradient',
      gradient: 'linear',
      stops: [{ position: 0, color: { argb: 'FF2E8B57' } }, { position: 1, color: { argb: 'FF3CB371' } }],
    };
    worksheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 50;
    worksheet.mergeCells('A2:H2');
    worksheet.getCell('A2').value = 'Meal Update List';
    worksheet.getCell('A2').font = { name: 'Arial', size: 14, bold: true };
    worksheet.getCell('A2').alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(2).height = 30;
    worksheet.getCell('A3').value = `Batch: ${user.batch}`;
    worksheet.getCell('A4').value = `Gender: ${user.gender}`;
    worksheet.getCell('A5').value = `Date: ${selectedDate.toLocaleDateString('en-GB')}`;
    worksheet.getCell('A6').value = `Generated: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`;
    ['A3', 'A4', 'A5', 'A6'].forEach(cell => {
      worksheet.getCell(cell).font = { name: 'Arial', size: 12, bold: true };
      worksheet.getCell(cell).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    });
    worksheet.getRow(7).values = ['Class Roll', 'Name', 'Meal', 'Additional Items', 'Lunch Served', 'Dinner Served', 'Daily Meal Count', 'Total'];
    worksheet.getRow(7).font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(7).fill = {
      type: 'gradient',
      gradient: 'linear',
      stops: [{ position: 0, color: { argb: 'FF4682B4' } }, { position: 1, color: { argb: 'FF6495ED' } }],
    };
    worksheet.getRow(7).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(7).height = 25;
    worksheet.columns = [
      { key: 'classRoll', width: 12 },
      { key: 'name', width: 30 },
      { key: 'meal', width: 15 },
      { key: 'additionalItems', width: 25 },
      { key: 'lunchServed', width: 15 },
      { key: 'dinnerServed', width: 15 },
      { key: 'dailyMealCount', width: 15 },
      { key: 'total', width: 18 },
    ];
    let rowIndex = 8, totalMealsSum = 0, totalLunch = 0, totalDinner = 0, totalDailyMealCount = 0;
    const additionalItemsCount = {};
    for (const user of users) {
      const mealHistory = mealHistories.find(mh => mh.userId.toString() === user._id.toString()) || {
        meal: 'Off', additionalItems: [], lunchServed: false, dinnerServed: false, dailyMealCount: 0,
      };
      totalMealsSum += user.totalMealCount || 0;
      totalLunch += mealHistory.lunchServed ? 1 : 0;
      totalDinner += mealHistory.dinnerServed ? 1 : 0;
      totalDailyMealCount += mealHistory.dailyMealCount || 0;
      mealHistory.additionalItems.forEach(item => {
        additionalItemsCount[item] = (additionalItemsCount[item] || 0) + 1;
      });
      const row = worksheet.addRow({
        classRoll: user.classRoll,
        name: user.name,
        meal: mealHistory.meal,
        additionalItems: mealHistory.additionalItems.join(', ') || '-',
        lunchServed: mealHistory.lunchServed ? 'Yes' : 'No',
        dinnerServed: mealHistory.dinnerServed ? 'Yes' : 'No',
        dailyMealCount: mealHistory.dailyMealCount || 0,
        total: user.totalMealCount,
      });
      row.font = { name: 'Arial', size: 10 };
      row.alignment = { vertical: 'middle', horizontal: 'left' };
      row.eachCell(cell => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      rowIndex++;
    }
    const totalRow = worksheet.addRow({ name: 'Total (Cumulative)', total: totalMealsSum });
    totalRow.font = { name: 'Arial', size: 10, bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    totalRow.alignment = { vertical: 'middle', horizontal: 'left' };
    totalRow.eachCell(cell => {
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });
    rowIndex++;
    const additionalItemsSummary = Object.entries(additionalItemsCount)
      .map(([item, count]) => `${item}: ${count}`)
      .join(', ') || '-';
    const summaryRow = worksheet.addRow({
      name: 'Summary (Daily)',
      lunchServed: totalLunch,
      dinnerServed: totalDinner,
      dailyMealCount: totalDailyMealCount,
      additionalItems: additionalItemsSummary,
    });
    summaryRow.font = { name: 'Arial', size: 10, bold: true };
    summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    summaryRow.alignment = { vertical: 'middle', horizontal: 'left' };
    summaryRow.eachCell(cell => {
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });
    const fileName = `Meal_Update_B${user.batch}_${user.gender}_${selectedDate.toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Excel export error:', error.message);
    res.status(500).send('Error exporting Excel');
  }
});

app.get('/admin/export-meal-history', requireAdmin, async (req, res) => {
  try {
    const { batch, gender, date } = req.query;
    if (!date) return res.status(400).send('Date parameter is required');
    const selectedDate = new Date(date);
    if (isNaN(selectedDate.getTime())) return res.status(400).send('Invalid date format');
    selectedDate.setHours(0, 0, 0, 0);
    let query = {};
    if (batch && batch !== 'all') query.batch = batch;
    if (gender && gender !== 'all') query.gender = gender;
    const users = await User.find(query).sort({ batch: 1, classRoll: 1 }).lean();
    if (!users.length) return res.status(404).send('No users found');
    const mealHistories = await MealHistory.find({
      userId: { $in: users.map(u => u._id) },
      date: selectedDate,
    }).lean();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Meal_History_B${batch || 'All'}_${gender || 'All'}`);
    worksheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 7 }];
    worksheet.properties.defaultRowHeight = 20;
    worksheet.mergeCells('A1:H1');
    worksheet.getCell('A1').value = 'Satkhira Medical College';
    worksheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getCell('A1').fill = {
      type: 'gradient',
      gradient: 'linear',
      stops: [{ position: 0, color: { argb: 'FF2E8B57' } }, { position: 1, color: { argb: 'FF3CB371' } }],
    };
    worksheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 50;
    worksheet.mergeCells('A2:H2');
    worksheet.getCell('A2').value = 'Meal History Report';
    worksheet.getCell('A2').font = { name: 'Arial', size: 14, bold: true };
    worksheet.getCell('A2').alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(2).height = 25;
    worksheet.getCell('A3').value = `Batch: ${batch || 'All'}`;
    worksheet.getCell('A4').value = `Gender: ${gender || 'All'}`;
    worksheet.getCell('A5').value = `Date: ${selectedDate.toLocaleDateString('en-GB')}`;
    worksheet.getCell('A6').value = `Generated: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`;
    ['A3', 'A4', 'A5', 'A6'].forEach(cell => {
      worksheet.getCell(cell).font = { name: 'Arial', size: 12, bold: true };
      worksheet.getCell(cell).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    });
    worksheet.getRow(7).values = ['Class Roll', 'Name', 'Meal', 'Additional Items', 'Lunch Served', 'Dinner Served', 'Daily Meal Count', 'Total Meals'];
    worksheet.getRow(7).font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(7).fill = {
      type: 'gradient',
      gradient: 'linear',
      stops: [{ position: 0, color: { argb: 'FF4682B4' } }, { position: 1, color: { argb: 'FF6495ED' } }],
    };
    worksheet.getRow(7).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(7).height = 25;
    worksheet.columns = [
      { key: 'classRoll', width: 12 },
      { key: 'name', width: 30 },
      { key: 'meal', width: 15 },
      { key: 'additionalItems', width: 25 },
      { key: 'lunchServed', width: 15 },
      { key: 'dinnerServed', width: 15 },
      { key: 'dailyMealCount', width: 15 },
      { key: 'totalMeals', width: 18 },
    ];
    let rowIndex = 8, totalLunch = 0, totalDinner = 0, totalDailyMealCount = 0, totalMealsSum = 0;
    const additionalItemsCount = {};
    for (const user of users) {
      const mealHistory = mealHistories.find(mh => mh.userId.toString() === user._id.toString()) || {
        meal: 'Off', additionalItems: [], lunchServed: false, dinnerServed: false, dailyMealCount: 0,
      };
      totalMealsSum += user.totalMealCount || 0;
      totalLunch += mealHistory.lunchServed ? 1 : 0;
      totalDinner += mealHistory.dinnerServed ? 1 : 0;
      totalDailyMealCount += mealHistory.dailyMealCount || 0;
      mealHistory.additionalItems.forEach(item => {
        additionalItemsCount[item] = (additionalItemsCount[item] || 0) + 1;
      });
      const row = worksheet.addRow({
        classRoll: user.classRoll,
        name: user.name,
        meal: mealHistory.meal,
        additionalItems: mealHistory.additionalItems.join(', ') || '-',
        lunchServed: mealHistory.lunchServed ? 'Yes' : 'No',
        dinnerServed: mealHistory.dinnerServed ? 'Yes' : 'No',
        dailyMealCount: mealHistory.dailyMealCount || 0,
        totalMeals: user.totalMealCount,
      });
      row.font = { name: 'Arial', size: 10 };
      row.alignment = { vertical: 'middle', horizontal: 'left' };
      row.eachCell(cell => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      rowIndex++;
    }
    const totalRow = worksheet.addRow({ name: 'Total (Cumulative)', totalMeals: totalMealsSum });
    totalRow.font = { name: 'Arial', size: 10, bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    totalRow.alignment = { vertical: 'middle', horizontal: 'left' };
    totalRow.eachCell(cell => {
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });
    rowIndex++;
    const additionalItemsSummary = Object.entries(additionalItemsCount)
      .map(([item, count]) => `${item}: ${count}`)
      .join(', ') || '-';
    const summaryRow = worksheet.addRow({
      name: `Summary (${selectedDate.toLocaleDateString('en-GB')})`,
      lunchServed: totalLunch,
      dinnerServed: totalDinner,
      dailyMealCount: totalDailyMealCount,
      additionalItems: additionalItemsSummary,
    });
    summaryRow.font = { name: 'Arial', size: 10, bold: true };
    summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    summaryRow.alignment = { vertical: 'middle', horizontal: 'left' };
    summaryRow.eachCell(cell => {
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });
    const fileName = `Meal_History_B${batch || 'All'}_${gender || 'All'}_${selectedDate.toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Meal history export error:', error.message);
    res.status(500).send('Error exporting meal history Excel');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Session destroy error:', err.message);
      return res.status(500).send('Error logging out');
    }
    res.redirect('/admin/login');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Session destroy error:', err.message);
      return res.status(500).send('Error logging out');
    }
    res.redirect('/login');
  });
});

// Start Server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} at ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});