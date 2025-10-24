const { S3Client } = require("@aws-sdk/client-s3");
require('dotenv').config();

const s3Client = new S3Client({
    region: process.env.NCP_REGION,
    endpoint: process.env.NCP_ENDPOINT,
    credentials: {
        accessKeyId: process.env.NCP_ACCESS_KEY,
        secretAccessKey: process.env.NCP_SECRET_KEY,
    }
});

module.exports = s3Client;