import { S3Settings } from './settings';
import settings from '../settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

/**
 * Reads project IDs from a CSV file.
 * Supports:
 * - Single column or multi-column CSV files
 * - One project ID per line or comma-separated
 * - Comments (lines starting with #)
 * - Header row detection (skips non-numeric first line)
 * - Configurable column index for multi-column CSVs
 * 
 * @param filePath Path to the CSV file
 * @param columnIndex Column index (0-based) to read from. Default: 0 (first column)
 * @returns Array of project IDs
 */
export const readProjectIdsFromCsv = (filePath: string, columnIndex: number = 0): number[] => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const projectIds: number[] = [];
    let headerSkipped = false;

    console.log(`Reading project IDs from column ${columnIndex} (0-based index) in: ${filePath}`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) {
        continue;
      }

      // Split by comma to handle comma-separated values
      const values = line.split(',').map(v => v.trim());

      // Check if columnIndex is valid for this row
      if (columnIndex >= values.length) {
        console.warn(`Warning: Line ${i + 1} has only ${values.length} column(s), skipping (need column ${columnIndex})`);
        continue;
      }

      const value = values[columnIndex];
      
      if (!value) continue;

      const num = parseInt(value, 10);
      
      // Skip header row (non-numeric values) - only check first data line
      if (!headerSkipped && isNaN(num)) {
        console.log(`Skipping CSV header row: "${line}"`);
        headerSkipped = true;
        continue;
      }

      if (isNaN(num)) {
        console.warn(`Warning: Line ${i + 1}, Column ${columnIndex}: Skipping invalid project ID: "${value}"`);
        continue;
      }

      projectIds.push(num);
    }

    if (projectIds.length === 0) {
      throw new Error(`No valid project IDs found in CSV file: ${filePath} (column ${columnIndex})`);
    }

    console.log(`✓ Loaded ${projectIds.length} project ID(s) from CSV column ${columnIndex}`);
    return projectIds;
  } catch (err) {
    console.error(`Error reading CSV file: ${err.message}`);
    throw err;
  }
};

// Creates new attachments and replaces old links
export const migrateAttachments = async (
  body: string,
  githubRepoId: number | undefined,
  s3: S3Settings | undefined,
  gitlabHelper: GitlabHelper
) => {
  const regexp = /(!?)\[([^\]]+)\]\((\/uploads[^)]+)\)/g;

  // Maps link offset to a new name in S3
  const offsetToAttachment: {
    [key: number]: string;
  } = {};

  // Find all local links
  const matches = body.matchAll(regexp);

  for (const match of matches) {
    const prefix = match[1] || '';
    const name = match[2];
    const url = match[3];

    if (s3 && s3.bucket) {
      const basename = path.basename(url);
      const mimeType = mime.lookup(basename);
      const attachmentBuffer = await gitlabHelper.getAttachment(url);
      if (!attachmentBuffer) {
        continue;
      }

      // // Generate file name for S3 bucket from URL
      const hash = crypto.createHash('sha256');
      hash.update(url);
      const newFileName = hash.digest('hex') + '/' + basename;
      const relativePath = githubRepoId
        ? `${githubRepoId}/${newFileName}`
        : newFileName;
      // Doesn't seem like it is easy to upload an issue to github, so upload to S3
      //https://stackoverflow.com/questions/41581151/how-to-upload-an-image-to-use-in-issue-comments-via-github-api

      // Attempt to fix issue #140
      //const s3url = `https://${s3.bucket}.s3.amazonaws.com/${relativePath}`;
      let hostname = `${s3.bucket}.s3.amazonaws.com`;
      if (s3.region) {
        hostname = `s3.${s3.region}.amazonaws.com/${s3.bucket}`;
      }
      const s3url = `https://${hostname}/${relativePath}`;

      const s3bucket = new S3();
      s3bucket.createBucket(() => {
        const params: S3.PutObjectRequest = {
          Key: relativePath,
          Body: attachmentBuffer,
          ContentType: mimeType === false ? undefined : mimeType,
          Bucket: s3.bucket,
        };

        s3bucket.upload(params, function (err, data) {
          console.log(`\tUploading ${basename} to ${s3url}... `);
          if (err) {
            console.log('ERROR: ', err);
          } else {
            console.log(`\t...Done uploading`);
          }
        });
      });

      // Add the new URL to the map
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${s3url})`;
    } else {
      // Not using S3: default to old URL, adding absolute path
      const host = gitlabHelper.host.endsWith('/')
        ? gitlabHelper.host
        : gitlabHelper.host + '/';
      const attachmentUrl = host + gitlabHelper.projectPath + url;
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${attachmentUrl})`;
    }
  }

  return body.replace(
    regexp,
    ({}, {}, {}, {}, offset, {}) => offsetToAttachment[offset]
  );
};

export const organizationUsersString = (users: string[], prefix: string): string => {
  let organizationUsers = [];
  for (let assignee of users) {
    let githubUser = settings.usermap[assignee as string];
    if (githubUser) {
      githubUser = '@' + githubUser;
    } else {
      githubUser = assignee as string;
    }
    organizationUsers.push(githubUser);
  }

  if (organizationUsers.length > 0) {
    return `\n\n**${prefix}:** ` + organizationUsers.join(', ');
  }

  return '';
}
