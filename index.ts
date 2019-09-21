import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import {Output} from "@pulumi/pulumi";

const config = new pulumi.Config();
const dbUser = config.require("dbuser");
const dbPassword = config.requireSecret("dbpass");

//VPC
const vpc = new awsx.ec2.Vpc('hd-vpc', {
    cidrBlock: "192.168.0.0/24",
    numberOfAvailabilityZones: 2,
    subnets: [
        {type: "public", cidrMask: 27},
    ],
    instanceTenancy:"default",
});

export const vpcId = vpc.id;
export const vpcPublicSubnetIds = vpc.publicSubnetIds;

const dbSubnet = new aws.rds.SubnetGroup("dbsubnet", {
    subnetIds: vpcPublicSubnetIds,
});
const dbSecurityGroup = new aws.ec2.SecurityGroup("indb", {
    ingress: [
        { protocol: "tcp", fromPort: 3306, toPort: 3306, cidrBlocks: ["192.168.0.0/24"] },
    ],
    vpcId: vpc.id,
});
const webSecurityGroup = new aws.ec2.SecurityGroup("insshwww", {
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["213.222.165.156/32"] },
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    vpcId: vpc.id,
});

//MySQL
const photoInstance = new aws.rds.Instance("photoinstance", {
    allocatedStorage: 5,
    engine: "mysql",
    engineVersion: "5.7",
    instanceClass: "db.t2.micro",
    name: "lychee",
    parameterGroupName: "default.mysql5.7",
    password: dbPassword,
    username: dbUser,
    storageType: "gp2",
    dbSubnetGroupName: dbSubnet.id,
    vpcSecurityGroupIds: [dbSecurityGroup.id],
    skipFinalSnapshot: true,
},{dependsOn: [dbSecurityGroup]});
export const rdsEndpoint = photoInstance.endpoint.apply(v => v.split(":")[0]);

//Webserver
const ami = aws.getAmi({
    filters: [{
        name: "name",
        values: ["amzn2-ami-hvm-*-x86_64-ebs"],
    }],
    owners: ["137112412989"], // Amazon
    mostRecent: true,
});

const webserverData =
    `#!/usr/bin/bash -x
sudo yum -y install python3-pip docker
sudo pip3 install -U docker-compose
sudo usermod -a -G docker ec2-user
sudo systemctl enable docker
sudo systemctl restart docker
mkdir -p /home/ec2-user/lychee/conf
mkdir -p /home/ec2-user/lychee/uploads
cd /home/ec2-user/lychee
cat - >docker-compose.yml<<EOF
---
version: "3"
services:
  lychee:
    image: bigrob8181/lychee-laravel
    container_name: lychee_laravel
    ports:
      - 80:80
    volumes:
      - ./conf:/conf
      - ./uploads:/uploads
    environment:
      - PHP_TZ=Europe/Budapest
      - DB_CONNECTION=mysql
      - DB_HOST=${pulumi.interpolate `rdsEndpoint`}
      - DB_PORT=3306
      - DB_DATABASE=lychee
      - DB_USERNAME="${dbUser}"
      - DB_PASSWORD=${pulumi.interpolate `dbPassword`}
    restart: unless-stopped
EOF

docker-compose up -d
`;
const webserver = new aws.ec2.Instance("webserver",{
    instanceType: "t2.micro",
    securityGroups: [webSecurityGroup.id],
    ami: ami.id,
    keyName:"sshkey",
    subnetId: vpcPublicSubnetIds[0],
    userData: webserverData,
},{dependsOn: [webSecurityGroup,photoInstance]});

export const publicIp = webserver.publicIp;
export const publicHostName = webserver.publicDns;
//ami-00aa4671cbf840d82
