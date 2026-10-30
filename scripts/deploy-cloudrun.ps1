[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
    [string]$ProjectId,
    [ValidatePattern('^[a-z]+-[a-z]+[0-9]{1,2}$')]
    [string]$Region = 'us-central1',
    [string]$PublicUrl = ''
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
Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project=$ProjectId
$repository = & gcloud.cmd artifacts repositories list --location=$Region --project=$ProjectId --filter='name:repositories/gmail-cleanup' --format='value(name)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the image repository.' }
if (-not $repository) { Invoke-Gcloud artifacts repositories create gmail-cleanup --repository-format=docker --location=$Region --project=$ProjectId --description='Gmail-cleanup application images' }
$runtimeAccount = "gmail-cleanup-web@${ProjectId}.iam.gserviceaccount.com"
$accounts = & gcloud.cmd iam service-accounts list --project=$ProjectId --filter="email:$runtimeAccount" --format='value(email)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the runtime identity.' }
if (-not $accounts) { Invoke-Gcloud iam service-accounts create gmail-cleanup-web --project=$ProjectId --display-name='Inboxclean web service' }
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
$imageTag = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
Invoke-Gcloud builds submit . --config=deploy/cloudbuild.yaml --project=$ProjectId --service-account="projects/$ProjectId/serviceAccounts/$buildAccount" --gcs-source-staging-dir="gs://$sourceBucket/source" "--substitutions=_REGION=$Region,_IMAGE_TAG=$imageTag"
$image = "${Region}-docker.pkg.dev/${ProjectId}/gmail-cleanup/web:${imageTag}"
& node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/deploy-secrets.mjs $ProjectId
if ($LASTEXITCODE -ne 0) { throw 'Runtime secrets could not be configured. The existing service was not replaced.' }
$bindings = Get-Content -LiteralPath data/cloud-run-bindings.json -Raw | ConvertFrom-Json
$projectNumber = & gcloud.cmd projects describe $ProjectId --format='value(projectNumber)'
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve project number.' }
$appUrl = "https://gmail-cleanup-web-${projectNumber}.${Region}.run.app"
# Preserve a configured custom domain on subsequent deployments. An explicit
# PublicUrl is available for the first cutover after DNS, TLS and OAuth are ready.
$existingJson = & gcloud.cmd run services list --project=$ProjectId --region=$Region --filter='metadata.name=gmail-cleanup-web' --format=json
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the existing public URL.' }
$existingServices = @($existingJson | ConvertFrom-Json)
if ($existingServices.Count -gt 0) {
    $savedUrl = $existingServices[0].spec.template.spec.containers[0].env | Where-Object name -eq 'APP_URL' | Select-Object -ExpandProperty value
    if ($savedUrl) { $appUrl = $savedUrl }
}
if ($PublicUrl) {
    $parsedUrl = [uri]$PublicUrl
    if ($parsedUrl.Scheme -ne 'https' -or $parsedUrl.AbsolutePath -ne '/' -or $parsedUrl.Query -or $parsedUrl.Fragment -or $parsedUrl.UserInfo) { throw 'PublicUrl must be an HTTPS origin.' }
    $appUrl = $parsedUrl.GetLeftPart([System.UriPartial]::Authority)
}
$environment = "APP_URL=$appUrl,HOST=0.0.0.0,SERVE_LANDING=true,ENABLE_LOCAL_SCHEDULER=false,HACKATHON_MODE=true,NEBIUS_MODEL=$($bindings.model)"
Invoke-Gcloud run deploy gmail-cleanup-web --image=$image --project=$ProjectId --region=$Region --service-account=$runtimeAccount --allow-unauthenticated --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --concurrency=8 --timeout=3600s --cpu-throttling "--update-env-vars=$environment" "--set-secrets=$($bindings.secrets)"
$siteUrl = & gcloud.cmd run services describe gmail-cleanup-web --project=$ProjectId --region=$Region --format='value(status.url)'
if ($LASTEXITCODE -ne 0 -or -not $siteUrl) { throw 'Deployment returned no service URL. Inspect Cloud Run status before retrying.' }
$health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 60
if ($health.stage -ne 'gmail-agent' -or -not $health.gmailConfigured -or -not $health.aiConfigured -or -not $health.connected) { throw 'Unexpected deployment health response.' }
Write-Output "Verified Gmail agent and Neon database: $appUrl/app"
& (Join-Path $PSScriptRoot 'deploy-scheduler.ps1') -ProjectId $ProjectId -Region $Region
if ($LASTEXITCODE -ne 0) { throw 'The app is deployed, but scheduler setup needs attention.' }
