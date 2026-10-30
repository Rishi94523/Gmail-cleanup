[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$ProjectId,[string]$Region='us-central1')
$ErrorActionPreference='Stop'
function Invoke-Gcloud { & gcloud.cmd @args; if ($LASTEXITCODE -ne 0) { throw 'Scheduler setup failed. Check the command output.' } }
Invoke-Gcloud services enable cloudscheduler.googleapis.com --project=$ProjectId
$identity="gmail-cleanup-scheduler@${ProjectId}.iam.gserviceaccount.com"
$existing=& gcloud.cmd iam service-accounts list --project=$ProjectId --filter="email:$identity" --format='value(email)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect scheduler identity.' }
if (-not $existing) { Invoke-Gcloud iam service-accounts create gmail-cleanup-scheduler --project=$ProjectId --display-name='Inboxclean daily scheduler' }
Invoke-Gcloud run services add-iam-policy-binding gmail-cleanup-web --project=$ProjectId --region=$Region --member="serviceAccount:$identity" --role=roles/run.invoker --quiet
$projectNumber=& gcloud.cmd projects describe $ProjectId --format='value(projectNumber)'
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve project number.' }
$appUrl="https://gmail-cleanup-web-${projectNumber}.${Region}.run.app"
Invoke-Gcloud run services update gmail-cleanup-web --project=$ProjectId --region=$Region "--update-env-vars=HACKATHON_MODE=true,SCHEDULER_SERVICE_ACCOUNT=$identity,SCHEDULER_AUDIENCE=$appUrl"
$job=& gcloud.cmd scheduler jobs list --project=$ProjectId --location=$Region --filter='name:gmail-cleanup-daily' --format='value(name)'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect scheduler jobs.' }
$verb=if($job){'update'}else{'create'}
Invoke-Gcloud scheduler jobs $verb http gmail-cleanup-daily --project=$ProjectId --location=$Region --schedule='*/5 * * * *' --time-zone=UTC --uri="$appUrl/internal/scheduler/tick" --http-method=POST --oidc-service-account-email=$identity --oidc-token-audience=$appUrl --attempt-deadline=1800s --max-retry-attempts=0
Write-Output 'Daily scheduler connected. Only accounts that explicitly enabled a routine are eligible; each is claimed at most once per local day.'
