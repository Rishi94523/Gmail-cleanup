[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
    [string]$ProjectId,
    [ValidatePattern('^[a-z]+-[a-z]+[0-9]{1,2}$')]
    [string]$Region = 'us-central1'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
function Invoke-Gcloud {
    & gcloud.cmd @args
    if ($LASTEXITCODE -ne 0) { throw "gcloud failed. No later deployment steps were run." }
}
# Explicit --project on every command avoids modifying the user's global config.
$billingJson = & gcloud.cmd billing projects describe $ProjectId --format=json
if ($LASTEXITCODE -ne 0) { throw 'Could not verify project billing. Sign in and check project access.' }
$billing = $billingJson | ConvertFrom-Json
if (-not $billing.billingEnabled) { throw 'Link an active billing account to the selected project before deploying.' }
Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project=$ProjectId
$repository = & gcloud.cmd artifacts repositories list --location=$Region --project=$ProjectId --filter='name:repositories/gmail-cleanup' --format='value(name)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the image repository.' }
if (-not $repository) { Invoke-Gcloud artifacts repositories create gmail-cleanup --repository-format=docker --location=$Region --project=$ProjectId --description='Gmail-cleanup application images' }
$runtimeAccount = "gmail-cleanup-web@${ProjectId}.iam.gserviceaccount.com"
$accounts = & gcloud.cmd iam service-accounts list --project=$ProjectId --filter="email:$runtimeAccount" --format='value(email)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the runtime identity.' }
if (-not $accounts) { Invoke-Gcloud iam service-accounts create gmail-cleanup-web --project=$ProjectId --display-name='Gmail cleanup public preview' }
$buildAccount = "gmail-cleanup-build@${ProjectId}.iam.gserviceaccount.com"
$buildAccounts = & gcloud.cmd iam service-accounts list --project=$ProjectId --filter="email:$buildAccount" --format='value(email)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the build identity.' }
if (-not $buildAccounts) { Invoke-Gcloud iam service-accounts create gmail-cleanup-build --project=$ProjectId --display-name='Gmail cleanup image builder' }
$sourceBucket = "${ProjectId}_cloudbuild"
$buckets = & gcloud.cmd storage buckets list --project=$ProjectId --filter="name:$sourceBucket" --format='value(name)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the source bucket.' }
if (-not $buckets) { Invoke-Gcloud storage buckets create "gs://$sourceBucket" --project=$ProjectId --location=$Region --uniform-bucket-level-access }
# Build-only identity: object reads in one bucket, image writes in one repository,
# and log writes in this project. No Editor/Owner or runtime data access grants.
Invoke-Gcloud storage buckets add-iam-policy-binding "gs://$sourceBucket" --member="serviceAccount:$buildAccount" --role=roles/storage.objectViewer --project=$ProjectId --quiet
Invoke-Gcloud artifacts repositories add-iam-policy-binding gmail-cleanup --location=$Region --project=$ProjectId --member="serviceAccount:$buildAccount" --role=roles/artifactregistry.writer --quiet
Invoke-Gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$buildAccount" --role=roles/logging.logWriter --condition=None --quiet
$imageTag = Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss'
Invoke-Gcloud builds submit . --config=deploy/cloudbuild.yaml --project=$ProjectId --service-account="projects/$ProjectId/serviceAccounts/$buildAccount" --gcs-source-staging-dir="gs://$sourceBucket/source" "--substitutions=_REGION=$Region,_IMAGE_TAG=$imageTag"
$image = "${Region}-docker.pkg.dev/${ProjectId}/gmail-cleanup/web:${imageTag}"
Invoke-Gcloud run deploy gmail-cleanup-web --image=$image --project=$ProjectId --region=$Region --service-account=$runtimeAccount --allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --concurrency=80 --timeout=60s --cpu-throttling
$siteUrl = & gcloud.cmd run services describe gmail-cleanup-web --project=$ProjectId --region=$Region --format='value(status.url)'
if ($LASTEXITCODE -ne 0 -or -not $siteUrl) { throw 'Deployment returned no service URL. Inspect Cloud Run status before retrying.' }
$health = Invoke-RestMethod -Uri "$siteUrl/healthz" -TimeoutSec 60
if ($health.stage -ne 'public-product-preview' -or $health.gmailEnabled -ne $false) { throw 'Unexpected deployment health response.' }
Write-Output "Verified public product preview: $siteUrl"
Write-Output 'This release does not enable live Gmail or daily processing. Cloud Run, build, and image storage usage may incur charges.'
