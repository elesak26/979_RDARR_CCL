# CI/CD Pipeline for Application Management

This master pipeline provides a unified interface to manage various aspects of the application, including starting, stopping, and restarting appservices, building and pushing images, and managing configuration. You can select a pipeline from the available options using the `choosePipeline` parameter, then provide the required parameters values for the selected pipeline.

## Required Setup

### Variable Group Configuration
- **Variable Group**: Replace `fillme` with your actual variable group name in the pipeline

### Required Variables in Variable Group
The following variables must be defined in your variable group:

**Application Variables:**
- `appName`: Name of the web application
- `resourceGroupName`: Azure resource group name
- `subscriptionName`: Azure subscription name  
- `environment`: Environment (`dev` or `qa`)
- `type`: Application type (e.g., `webapp`, `functionapp`)

**Repository Variables:**
- `project`: Azure DevOps project name
- `repo`: Repository name
- `branch`: Branch name to use

**Container Registry Variables:**
- `devContainerRegistry`: Development container registry name
- `qaContainerRegistry`: QA container registry name

**Service Connection Variables:**
- Replace `fillProjectServiceConnection` with your actual service connection name
- Replace `fillProjectAgentPool` with your actual agent pool name

## Pipeline Parameters

The following parameters control the pipeline's behavior:

- **choosePipeline** (string, default: `getConfiguration`):  
  Selects the operation to run. Available values:
  - `startApplication`: Starts the application.
  - `restartApplication`: Restarts the application.
  - `stopApplication`: Stops the application.
  - `getConfiguration`: Retrieves current application configuration.
  - `setConfiguration`: Sets or updates configuration from a file.
  - `delConfiguration`: Deletes specified configuration settings.
  - `buildAndPushNewImage`: Builds and pushes a new Docker image to the specified registry.
  - `changeImage`: Changes the images on the webapp.

### Parameter Details for Each Pipeline

1. **Application Management**
   - **startApplication / restartApplication / stopApplication**:  
     These options manage the application state. No additional parameters are required.

2. **Configuration Management**
   - **getConfiguration**:  
     Retrieves the current configuration of the application. No additional parameters are required.

   - **setConfiguration** (used only when `choosePipeline` is set to `setConfiguration`):  
     Updates application configuration from a specified file.  
     - `filePath` (string, default: `fillConfiguration`): Path to the configuration file, relative to the repository root (e.g., `foo/bar/configuration.yaml`).

   - **delConfiguration** (used only when `choosePipeline` is set to `delConfiguration`):  
     Deletes specified configuration settings.  
     - `settingsToDelete` (string, default: `" "`): Space-separated list of settings to remove (e.g., `FOO hello`).

3. **Image Management**
   - **buildAndPushNewImage**:  
     Builds and pushes a new Docker image.  
     - `imageRepository` (string, default: `fillDockerImage`): Complete image name with tag (e.g., `bd/pothenesxes:v3.1`).
     - `dockerfilePath` (string, default: `fillDockerfile`): Path to the Dockerfile, relative to the project root (e.g., `foo/bar/Dockerfile`).
     - `versionUpgrade` (string, default: `patch`, options: `major, minor, patch`): Version upgrade type for the image build. First build defaults to version 1.0.0 (e.g., `patch 1.0.1`). 
     - `changeImageOnWebapp` (boolean, default: `false`): If `true`, updates the web application to use the new image.

   - **changeImage**:  
     Changes the image on the webapp without building.  
     - `imageRepositoryAndTag` (string, default: `fillDockerImage`): Complete image name with tag to deploy (e.g., `bd/pothenesxes:v3.1`).

## Pipeline Variables

This pipeline uses several predefined variables that specify environment-specific values, including resource names and service connections. Key variables include:

- **serviceConnection**: Specifies the service connection based on the environment (`dev` or production).
- **agentPool**: Sets the agent pool for executing jobs.
- **devServiceConnection**: Specifies the development environment's service connection.

## Pipeline Workflow

Each job uses templates defined in the `templates/application` directory. These templates define the actions for each pipeline choice:

- **Application Management Templates**:  
  Uses `app-service-start.yaml`, `app-service-restart.yaml`, and `app-service-stop.yaml` templates to manage the application’s state.

- **Configuration Templates**:  
  Uses `app-get-config.yaml`, `app-set-config.yaml`, and `app-delete-config.yaml` templates for retrieving, setting, and deleting configurations.

- **Image Management Templates**:  
  Uses `build-and-push-image-to-acrs.yaml` to build and push Docker images, and `change-image.yaml` to update webapp images.

## Trigger

This pipeline does not have an automated trigger and should be run manually.

---

### Example Usage

To run this pipeline to set a new configuration:

1. Set `choosePipeline` to `setConfiguration`.
2. Provide the `filePath` pointing to the configuration file (e.g., `configuration/appsettings.json`).

For example:

```yaml
parameters:
  choosePipeline: setConfiguration
  filePath: configuration/appsettings.json
```

To build and push a new image:

```yaml
parameters:
  choosePipeline: buildAndPushNewImage
  imageRepositoryAndTag: bd/pothenesxes:v3.1
  dockerfilePath: foo/bar/Dockerfile
  changeImageOnWebapp: true
```
