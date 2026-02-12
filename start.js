#!/usr/bin/env node

// Ghost CMS startup for CloudPanel
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Start Ghost by requiring the index file
require('./current/index.js');
