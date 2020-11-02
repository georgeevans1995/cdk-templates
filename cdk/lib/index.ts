import * as cdk from "@aws-cdk/core";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecr from "@aws-cdk/aws-ecr";
import * as s3 from "@aws-cdk/aws-s3";
import * as iam from "@aws-cdk/aws-iam";
import * as route53 from "@aws-cdk/aws-route53";
import * as route53targets from "@aws-cdk/aws-route53-targets";
import * as certificatemanager from "@aws-cdk/aws-certificatemanager";

import * as elasticloadbalancing from "@aws-cdk/aws-elasticloadbalancingv2";

interface ECSStackProps extends cdk.StackProps {
  clientName: string;
  environment: string;
  domain: string;
  taskEnv: { [key: string]: string } | undefined;
  vpcId: string;
}

/**
 * EXAMPLE ECS
 *
 * A full provisioned ECS deployment setup
 *
 * Creates all ECS resources from docker containers through to domain configuration
 *
 */
export class ECSStack extends cdk.Stack {
  /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope: cdk.Construct, id: string, props: ECSStackProps) {
    super(scope, id, props);

    const clientName = props.clientName;
    const clientPrefix = `${clientName}-${props.environment}-server`;

    const vpc = ec2.Vpc.fromLookup(this, `${clientPrefix}-vpc`, {
      vpcId: props.vpcId,
    });

    const repository = new ecr.Repository(this, `${clientPrefix}-repository`, {
      repositoryName: `${clientPrefix}-repository`,
    });

    // The code that defines your stack goes here
    const cluster = new ecs.Cluster(this, `${clientPrefix}-cluster`, {
      clusterName: `${clientPrefix}-cluster`,
      vpc,
    });

    // load balancer resources
    const elb = new elasticloadbalancing.ApplicationLoadBalancer(
      this,
      `${clientPrefix}-elb`,
      {
        vpc,
        vpcSubnets: { subnets: vpc.publicSubnets },
        internetFacing: true,
      }
    );

    const zone = route53.HostedZone.fromLookup(this, `${clientPrefix}-zone`, {
      domainName: props.domain,
    });

    new route53.ARecord(this, `${clientPrefix}-domain`, {
      recordName: `${
        props.environment !== "production" ? `${props.environment}-` : ""
      }api.${props.domain}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(elb)
      ),
      ttl: cdk.Duration.seconds(300),
      comment: `${props.environment} API domain`,
      zone: zone,
    });

    const targetGroupHttp = new elasticloadbalancing.ApplicationTargetGroup(
      this,
      `${clientPrefix}-target`,
      {
        port: 80,
        vpc,
        protocol: elasticloadbalancing.ApplicationProtocol.HTTP,
        targetType: elasticloadbalancing.TargetType.IP,
      }
    );

    targetGroupHttp.configureHealthCheck({
      path: "/api/status",
      protocol: elasticloadbalancing.Protocol.HTTP,
    });

    const cert = new certificatemanager.Certificate(
      this,
      `${clientPrefix}-cert`,
      {
        domainName: props.domain,
        subjectAlternativeNames: [`*.${props.domain}`],
        validation: certificatemanager.CertificateValidation.fromDns(zone),
      }
    );
    const listener = elb.addListener("Listener", {
      open: true,
      port: 443,
      certificates: [cert],
    });

    listener.addTargetGroups(`${clientPrefix}-tg`, {
      targetGroups: [targetGroupHttp],
    });

    const elbSG = new ec2.SecurityGroup(this, `${clientPrefix}-elbSG`, {
      vpc,
      allowAllOutbound: true,
    });

    elbSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow https traffic"
    );

    elb.addSecurityGroup(elbSG);

    const bucket = new s3.Bucket(this, `${clientPrefix}-s3-bucket`, {
      bucketName: `${clientName}-${props.environment}-assets`,
    });

    const taskRole = new iam.Role(this, `${clientPrefix}-task-role`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: `${clientPrefix}-task-role`,
      description: "Role that the api task definitions use to run the api code",
    });

    taskRole.attachInlinePolicy(
      new iam.Policy(this, `${clientPrefix}-task-policy`, {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["S3:*"],
            resources: [bucket.bucketArn],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["SES:*"],
            resources: ["*"],
          }),
        ],
      })
    );

    const taskDefinition = new ecs.TaskDefinition(
      this,
      `${clientPrefix}-task`,
      {
        family: `${clientPrefix}-task`,
        compatibility: ecs.Compatibility.EC2_AND_FARGATE,
        cpu: "256",
        memoryMiB: "512",
        networkMode: ecs.NetworkMode.AWS_VPC,
        taskRole: taskRole,
      }
    );

    const image = ecs.RepositoryImage.fromEcrRepository(repository, "latest");

    const container = taskDefinition.addContainer(`${clientPrefix}-container`, {
      image: image,
      memoryLimitMiB: 512,
      environment: props.taskEnv,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: clientPrefix }),
    });

    container.addPortMappings({ containerPort: 80 });

    const ecsSG = new ec2.SecurityGroup(this, `${clientPrefix}-ecsSG`, {
      vpc,
      allowAllOutbound: true,
    });

    ecsSG.connections.allowFrom(
      elbSG,
      ec2.Port.allTcp(),
      "Application load balancer"
    );

    const service = new ecs.FargateService(this, `${clientPrefix}-service`, {
      cluster,
      desiredCount: 1,
      taskDefinition,
      securityGroups: [ecsSG],
      assignPublicIp: true,
    });

    service.attachToApplicationTargetGroup(targetGroupHttp);

    const scalableTaget = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });

    scalableTaget.scaleOnMemoryUtilization(`${clientPrefix}-ScaleUpMem`, {
      targetUtilizationPercent: 75,
    });

    scalableTaget.scaleOnCpuUtilization(`${clientPrefix}-ScaleUpCPU`, {
      targetUtilizationPercent: 75,
    });

    // outputs to be used in code deployments
    new cdk.CfnOutput(this, `${props.environment}ServiceName`, {
      exportName: `${props.environment}ServiceName`,
      value: service.serviceName,
    });

    new cdk.CfnOutput(this, `${props.environment}ImageRepositoryUri`, {
      exportName: `${props.environment}ImageRepositoryUri`,
      value: repository.repositoryUri,
    });

    new cdk.CfnOutput(this, `${props.environment}ImageName`, {
      exportName: `${props.environment}ImageName`,
      value: image.imageName,
    });

    new cdk.CfnOutput(this, `${props.environment}ClusterName`, {
      exportName: `${props.environment}ClusterName`,
      value: cluster.clusterName,
    });
  }
}
