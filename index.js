const express = require('express');
const mysql = require('mysql2');
require('dotenv').config();
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

//KONFIGURASI UPLOAD GAMBAR
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

//KONEKSI DATABASE
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

db.connect(err => {
    if (err) console.error('Error connecting to MySQL:', err);
    else console.log('Connected to MySQL via Laragon');
});

// FUNGSI BANTUAN: AUTO UPDATE STATISTIK
function updateUserStats(userId) {
    if (!userId) return;

    const countQuery = 'SELECT * FROM entertainments WHERE user_id = ?';
    db.query(countQuery, [userId], (err, entries) => {
        if (err) {
            console.error("Gagal hitung statistik background:", err);
            return;
        }

        let totalEntries = 0;
        let completedCount = 0;
        let averageRating = 0.0;
        let favoriteGenre = "-";

        if (entries.length > 0) {
            totalEntries = entries.length;
            
            completedCount = entries.filter(e => e.status && e.status.toLowerCase() === 'completed').length;
            
            const sumRating = entries.reduce((acc, curr) => acc + parseFloat(curr.rating || 0), 0);
            averageRating = (sumRating / totalEntries).toFixed(1);

            const genreCounts = {};
            entries.forEach(e => {
                if (e.genre && e.genre.trim() !== "") {
                    e.genre.split(',').forEach(rawGenre => {
                        const cleanGenre = rawGenre.trim();
                        if (cleanGenre) {
                            genreCounts[cleanGenre] = (genreCounts[cleanGenre] || 0) + 1;
                        }
                    });
                }
            });

            if (Object.keys(genreCounts).length > 0) {
                favoriteGenre = Object.keys(genreCounts).reduce((a, b) => genreCounts[a] > genreCounts[b] ? a : b);
            }
        }

        const updateStatSql = `
            INSERT INTO statistics (user_id, total_entries, completed_count, average_rating, favorite_genre)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            total_entries = VALUES(total_entries),
            completed_count = VALUES(completed_count),
            average_rating = VALUES(average_rating),
            favorite_genre = VALUES(favorite_genre)
        `;

        db.query(updateStatSql, [userId, totalEntries, completedCount, averageRating, favoriteGenre], (err) => {
            if (err) console.error("❌ Gagal update tabel statistik:", err);
            else console.log(`✅ Statistik User ID ${userId} berhasil diperbarui otomatis!`);
        });
    });
}

// ENDPOINT AUTHENTICATION

app.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
            return res.status(500).json({ message: 'Gagal mengenkripsi password', error: err });
        }
        const query = 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)';
        db.query(query, [username, email, hash], (err, result) => {
            if (err) {
                res.status(500).json({ message: 'Gagal mendaftar', error: err });
            } else {
                res.status(200).json({ message: 'Registrasi Berhasil', userId: result.insertId });
            }
        });
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const query = 'SELECT * FROM users WHERE email = ?';
    db.query(query, [email], (err, results) => {
        if (err) {
            return res.status(500).json({ message: 'Error server', error: err });
        }
        if (results.length > 0) {
            const user = results[0];
            bcrypt.compare(password, user.password, (err, isMatch) => {
                if (err) return res.status(500).json({ message: 'Error verifikasi' });
                if (isMatch) {
                    res.status(200).json({
                        success: true,
                        message: 'Login Berhasil',
                        data: {
                            id: user.id,
                            username: user.username,
                            email: user.email
                        }
                    });
                } else {
                    res.status(401).json({ success: false, message: 'Email atau Password salah' });
                }
            });
        } else {
            res.status(401).json({ success: false, message: 'Email atau Password salah' });
        }
    });
});


//GET ENTERTAINMENTS (Home & Search/Profile)
app.get('/entertainments', (req, res) => {
    const userId = req.query.userId || req.query.user_id;
    const search = req.query.query || req.query.search;
    const genre = req.query.genre;

    let query = "SELECT * FROM entertainments WHERE 1=1";
    let params = [];

    if (userId) {
        query += " AND user_id = ?";
        params.push(userId);
    }

    if (search && search.trim() !== "") {
        query += " AND title LIKE ?";
        params.push(`%${search}%`);
    }

    //by genre
    if (genre && genre.trim() !== "" && genre !== "null") {
        query += " AND genre LIKE ?";
        params.push(`%${genre}%`);
    }

    query += " ORDER BY created_at DESC";

    db.query(query, params, (err, results) => {
        if (err) {
            console.error("DB Error:", err);
            return res.status(500).json({ success: false });
        }
        res.json({ success: true, data: results });
    });
});


//GET DETAIL ITEM
app.get('/entertainments/:id', (req, res) => {
    const query = 'SELECT * FROM entertainments WHERE id = ?';
    db.query(query, [req.params.id], (err, results) => {
        if (err) {
            res.status(500).json({ success: false, message: 'Error server', error: err });
        } else if (results.length > 0) {
            res.status(200).json({ success: true, message: 'Data ditemukan', data: results[0] });
        } else {
            res.status(404).json({ success: false, message: 'Data tidak ditemukan', data: null });
        }
    });
});

//INSERT DATA BARU (AUTO UPDATE STATS)
app.post('/insert-entertainment', upload.single('photo'), (req, res) => {
    const { user_id, title, description, genre, category, status, rating } = req.body;
    // SELALU gunakan path lengkap dengan 'uploads/'
    const photo = req.file ? `uploads/${req.file.filename}` : null;

    const query = `
        INSERT INTO entertainments 
        (user_id, title, description, genre, photo, category, status, rating) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [user_id, title, description, genre, photo, category, status, rating], (err, result) => {
        if (err) {
            console.error("Gagal Insert:", err);
            res.status(500).json({
                success: false,
                message: 'Gagal menyimpan data',
                error: err
            });
        } else {
            updateUserStats(user_id);

            const newId = result.insertId;
            const getQuery = "SELECT * FROM entertainments WHERE id = ?";
            db.query(getQuery, [newId], (err, rows) => {
                if (!err && rows.length > 0) {
                    res.status(200).json({
                        success: true,
                        message: 'Data berhasil disimpan',
                        data: rows[0]
                    });
                } else {
                    res.status(200).json({ success: true, message: 'Berhasil', data: null });
                }
            });
        }
    });
});

//DELETE DATA (AUTO UPDATE STATS)
app.delete('/delete-entertainment/:id', (req, res) => {
    const id = req.params.id;

    const checkQuery = 'SELECT user_id FROM entertainments WHERE id = ?';
    
    db.query(checkQuery, [id], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
        }

        const userId = results[0].user_id;

        const deleteQuery = 'DELETE FROM entertainments WHERE id = ?';
        db.query(deleteQuery, [id], (err, result) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Gagal hapus', error: err });
            }

            updateUserStats(userId);

            res.status(200).json({ success: true, message: 'Berhasil dihapus dan statistik diperbarui' });
        });
    });
});

//UPDATE DATA (AUTO UPDATE STATS)
app.put('/update-entertainment/:id', upload.single('photo'), (req, res) => {
    const id = req.params.id;
    const { title, description, genre, category, status, rating } = req.body;
    
    // 1. Ambil data lama untuk mendapatkan foto lama
    const getOldQuery = 'SELECT photo FROM entertainments WHERE id = ?';
    
    db.query(getOldQuery, [id], (errOld, resultOld) => {
        if (errOld) {
            return res.status(500).json({ 
                success: false, 
                message: 'Gagal mengambil data lama', 
                error: errOld 
            });
        }
        
        let photoPath = null;
        
        // 2. Tentukan path foto yang akan disimpan
        if (req.file) {
            // Jika ada foto baru, gunakan path lengkap dengan 'uploads/'
            photoPath = `uploads/${req.file.filename}`;
        } else if (resultOld.length > 0 && resultOld[0].photo) {
            // Jika tidak ada foto baru, pertahankan foto lama
            photoPath = resultOld[0].photo;
        }
        // Jika photoPath tetap null, berarti tidak ada foto sama sekali
        
        // 3. Update data berdasarkan kondisi
        let query, params;
        
        if (photoPath !== null) {
            // Ada foto (baru atau lama)
            query = `UPDATE entertainments 
                     SET title=?, description=?, genre=?, photo=?, category=?, status=?, rating=? 
                     WHERE id=?`;
            params = [title, description, genre, photoPath, category, status, rating, id];
        } else {
            // Tidak ada foto sama sekali
            query = `UPDATE entertainments 
                     SET title=?, description=?, genre=?, photo=?, category=?, status=?, rating=? 
                     WHERE id=?`;
            params = [title, description, genre, null, category, status, rating, id];
        }
        
        db.query(query, params, (err, result) => {
            if (err) {
                console.error("Gagal Update:", err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Gagal update data', 
                    error: err 
                });
            }
            
            //Cari User ID untuk update statistik
            db.query('SELECT user_id FROM entertainments WHERE id = ?', [id], (errUser, resUser) => {
                if (!errUser && resUser.length > 0) {
                    const userId = resUser[0].user_id;
                    updateUserStats(userId);
                }
            });
            
            // 4. Ambil data yang sudah diupdate untuk response
            const getUpdatedQuery = 'SELECT * FROM entertainments WHERE id = ?';
            db.query(getUpdatedQuery, [id], (errGet, updatedResult) => {
                if (!errGet && updatedResult.length > 0) {
                    res.status(200).json({ 
                        success: true, 
                        message: 'Data berhasil diperbarui',
                        data: updatedResult[0]
                    });
                } else {
                    res.status(200).json({ 
                        success: true, 
                        message: 'Data berhasil diperbarui' 
                    });
                }
            });
        });
    });
});


// ENDPOINT USER PROFILE

app.put('/update-user/:id', (req, res) => {
    const id = req.params.id;
    const { username, email, password } = req.body;

    if (password && password.trim() !== "") {
        bcrypt.hash(password, 10, (err, hash) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Gagal enkripsi password', error: err });
            }
            const query = 'UPDATE users SET username = ?, email = ?, password = ? WHERE id = ?';
            db.query(query, [username, email, hash, id], (err, result) => {
                if (err) {
                    console.error("Gagal Update User:", err);
                    return res.status(500).json({ success: false, message: 'Gagal update profil', error: err });
                }
                res.status(200).json({ success: true, message: 'Profil dan password berhasil diperbarui' });
            });
        });
    } else {
        const query = 'UPDATE users SET username = ?, email = ? WHERE id = ?';
        db.query(query, [username, email, id], (err, result) => {
            if (err) {
                console.error("Gagal Update User:", err);
                return res.status(500).json({ success: false, message: 'Gagal update profil', error: err });
            }
            res.status(200).json({ success: true, message: 'Profil berhasil diperbarui' });
        });
    }
}); 

//STATISTICS (GET Only)
app.get('/statistics/:userId', (req, res) => {
    const userId = req.params.userId;
    
    updateUserStats(userId);

    const query = 'SELECT * FROM statistics WHERE user_id = ?';
    db.query(query, [userId], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err });

        if (results.length > 0) {
            const stat = results[0];
            
            const queryDetails = 'SELECT genre, status, category FROM entertainments WHERE user_id = ?';
            db.query(queryDetails, [userId], (err2, rows) => {
                const genreCounts = {};
                const statusDist = {};
                const categoryDist = {};

                if (!err2 && rows) {
                    rows.forEach(e => {
                        if (e.genre) {
                            e.genre.split(',').forEach(g => {
                                const clean = g.trim();
                                if(clean) genreCounts[clean] = (genreCounts[clean] || 0) + 1;
                            });
                        }
                        if (e.status) statusDist[e.status] = (statusDist[e.status] || 0) + 1;
                        if (e.category) {
                            const cat = e.category.toLowerCase();
                            categoryDist[cat] = (categoryDist[cat] || 0) + 1;
                        }
                    });
                }

                res.status(200).json({
                    success: true,
                    data: {
                        totalEntry: stat.total_entries,
                        averageRating: stat.average_rating,
                        favoriteGenre: stat.favorite_genre,
                        genreDistribution: genreCounts,
                        statusDistribution: statusDist,
                        categoryDistribution: categoryDist
                    }
                });
            });

        } else {
            res.status(200).json({
                success: true,
                data: {
                    totalEntry: 0,
                    averageRating: 0.0,
                    favoriteGenre: "-",
                    genreDistribution: {},
                    statusDistribution: {},
                    categoryDistribution: {}
                }
            });
        }
    });
});

//SERVER LISTEN
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});