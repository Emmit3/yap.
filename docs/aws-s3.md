# Small AWS integration: MP4 export to S3

The optional `aws:upload` command uploads a finished local MP4 to an existing private S3 bucket and prints a temporary download link. It uses the AWS SDK for JavaScript v3 already included in the API workspace. No AWS service is needed to start Yap.

## Configure

1. Create a general-purpose S3 bucket in your AWS account. Keep **Block Public Access enabled** and use the default S3 encryption for this example.
2. Configure a local AWS profile with permission to put and get objects under `exports/` in that bucket. For an IAM Identity Center profile, sign in with `aws sso login --profile yap`; use your own configured profile name. A deployed service can use its IAM role. The SDK resolves these through its [default credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).
3. Update `apps/api/.env`:

```dotenv
AWS_REGION=us-east-1
AWS_S3_BUCKET=your-existing-bucket
AWS_S3_PREFIX=exports/
AWS_PROFILE=yap
```

Choose the bucket's actual region. Omit `AWS_PROFILE` when using a service IAM role or your default local profile. Provider secrets and AWS credentials belong on the server; do not put them in `apps/web/.env`.

Attach a policy like this to the uploading identity, replacing the bucket name. If you change the prefix, update the policy to match.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::your-existing-bucket/exports/*"
    }
  ]
}
```

## Upload a render

After rendering a promo, run from the repository root:

```sh
npm run aws:upload -- ./data/videos/RENDER_ID.mp4
```

Replace `RENDER_ID` with the finished render's ID. npm runs the command inside `apps/api`, so relative paths start there. An absolute path to a downloaded MP4 also works.

The command streams the file into S3 under a unique object key with `video/mp4` content type, then prints JSON with the bucket, key, and `downloadUrl`. It requests a **15-minute** URL using a signed `GetObject` request. AWS documents this pattern in its [presigned download example](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/s3_example_s3_Scenario_PresignedUrl_section.html).

Anyone holding the URL can download the file while it is valid. Temporary credentials or bucket policy can shorten its lifetime; URL expiration does not delete the object. See [S3 presigned URL behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html). Uploads incur your account's normal S3 storage/request/transfer charges; the creator production budget does not meter this standalone command. Delete test objects or configure a lifecycle rule when you no longer need them.

This is an explicit export command. Photos, JSON stores, render jobs, and the web publish kit still use local storage. A later integration can call the upload helper after a successful render, save the object key, and mint fresh links when requested. AWS Bedrock for models or Polly for voiceover would be separate future adapters.

## Verification

The S3 tests use injected upload/signing functions and real local file streams. They check file validation, upload contents, temporary-link options, and failure behavior without contacting AWS. A live upload requires your bucket and credentials.
