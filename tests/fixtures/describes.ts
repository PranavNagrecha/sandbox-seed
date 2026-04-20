import type { SObjectDescribe } from "../../src/describe/types.ts";

/**
 * Simplified describes for a representative slice of Salesforce standard objects,
 * plus a synthetic cycle (Account.PrimaryContact__c ↔ Contact.AccountId) to exercise
 * the two-phase cycle handling. Not byte-for-byte faithful to real Salesforce
 * describe payloads — only the fields our builder reads are populated.
 */

export const ACCOUNT: SObjectDescribe = {
  name: "Account",
  label: "Account",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "Name", type: "string", nillable: false, custom: false, createable: true },
    {
      name: "ParentId",
      type: "reference",
      referenceTo: ["Account"],
      relationshipName: "Parent",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "OwnerId",
      type: "reference",
      referenceTo: ["User"],
      relationshipName: "Owner",
      nillable: false,
      custom: false,
      createable: true,
    },
    {
      name: "CreatedById",
      type: "reference",
      referenceTo: ["User"],
      relationshipName: "CreatedBy",
      nillable: false,
      custom: false,
      createable: false,
      defaultedOnCreate: true,
    },
    {
      name: "CreatedDate",
      type: "datetime",
      nillable: false,
      custom: false,
      createable: false,
      defaultedOnCreate: true,
    },
    {
      name: "FormulaField__c",
      type: "string",
      nillable: true,
      custom: true,
      createable: false,
      calculated: true,
    },
  ],
  childRelationships: [
    {
      childSObject: "Contact",
      field: "AccountId",
      relationshipName: "Contacts",
      cascadeDelete: false,
    },
    {
      childSObject: "Opportunity",
      field: "AccountId",
      relationshipName: "Opportunities",
      cascadeDelete: false,
    },
    {
      childSObject: "AccountHistory",
      field: "AccountId",
      relationshipName: "Histories",
      cascadeDelete: true,
    },
    {
      childSObject: "AccountFeed",
      field: "ParentId",
      relationshipName: "Feeds",
      cascadeDelete: true,
    },
  ],
};

export const ACCOUNT_WITH_CYCLE: SObjectDescribe = {
  ...ACCOUNT,
  fields: [
    ...ACCOUNT.fields,
    {
      name: "PrimaryContact__c",
      type: "reference",
      referenceTo: ["Contact"],
      relationshipName: "PrimaryContact__r",
      nillable: true,
      custom: true,
      createable: true,
    },
  ],
};

export const CONTACT: SObjectDescribe = {
  name: "Contact",
  label: "Contact",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "LastName", type: "string", nillable: false, custom: false, createable: true },
    {
      name: "Email",
      type: "email",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "Phone",
      type: "phone",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "AccountId",
      type: "reference",
      referenceTo: ["Account"],
      relationshipName: "Account",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "OwnerId",
      type: "reference",
      referenceTo: ["User"],
      relationshipName: "Owner",
      nillable: false,
      custom: false,
      createable: true,
    },
  ],
  childRelationships: [
    {
      childSObject: "Case",
      field: "ContactId",
      relationshipName: "Cases",
      cascadeDelete: false,
    },
  ],
};

export const CONTACT_WITH_REPORTS_TO: SObjectDescribe = {
  ...CONTACT,
  fields: [
    ...CONTACT.fields,
    {
      name: "ReportsToId",
      type: "reference",
      referenceTo: ["Contact"],
      relationshipName: "ReportsTo",
      nillable: true,
      custom: false,
      createable: true,
    },
  ],
};

export const OPPORTUNITY: SObjectDescribe = {
  name: "Opportunity",
  label: "Opportunity",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "Name", type: "string", nillable: false, custom: false, createable: true },
    {
      name: "AccountId",
      type: "reference",
      referenceTo: ["Account"],
      relationshipName: "Account",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "OwnerId",
      type: "reference",
      referenceTo: ["User"],
      relationshipName: "Owner",
      nillable: false,
      custom: false,
      createable: true,
    },
  ],
};

export const OPPORTUNITY_WITH_PRICEBOOK: SObjectDescribe = {
  ...OPPORTUNITY,
  fields: [
    ...OPPORTUNITY.fields,
    {
      name: "Pricebook2Id",
      type: "reference",
      referenceTo: ["Pricebook2"],
      relationshipName: "Pricebook2",
      nillable: true,
      custom: false,
      createable: true,
    },
  ],
};

export const PRICEBOOK2: SObjectDescribe = {
  name: "Pricebook2",
  label: "Price Book",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "Name", type: "string", nillable: false, custom: false, createable: true },
    { name: "IsActive", type: "boolean", nillable: false, custom: false, createable: true },
  ],
};

export const CASE: SObjectDescribe = {
  name: "Case",
  label: "Case",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "CaseNumber", type: "string", nillable: false, custom: false, createable: false, defaultedOnCreate: true },
    { name: "Subject", type: "string", nillable: true, custom: false, createable: true },
    {
      name: "AccountId",
      type: "reference",
      referenceTo: ["Account"],
      relationshipName: "Account",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "ContactId",
      type: "reference",
      referenceTo: ["Contact"],
      relationshipName: "Contact",
      nillable: true,
      custom: false,
      createable: true,
    },
  ],
  childRelationships: [
    {
      childSObject: "CaseComment",
      field: "ParentId",
      relationshipName: "CaseComments",
      cascadeDelete: true,
    },
    {
      childSObject: "CaseHistory",
      field: "CaseId",
      relationshipName: "Histories",
      cascadeDelete: true,
    },
  ],
  recordTypeInfos: [
    {
      developerName: "Master",
      name: "Master",
      active: true,
      master: true,
    },
    {
      developerName: "Support",
      name: "Support",
      active: true,
      master: false,
    },
  ],
};

export const CASE_COMMENT: SObjectDescribe = {
  name: "CaseComment",
  label: "Case Comment",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    {
      name: "ParentId",
      type: "reference",
      referenceTo: ["Case"],
      relationshipName: "Parent",
      nillable: false,
      custom: false,
      createable: true,
      cascadeDelete: true, // master-detail
    },
    { name: "CommentBody", type: "textarea", nillable: true, custom: false, createable: true },
  ],
};

export const TASK: SObjectDescribe = {
  name: "Task",
  label: "Task",
  custom: false,
  queryable: true,
  createable: true,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "Subject", type: "string", nillable: true, custom: false, createable: true },
    {
      name: "WhatId",
      type: "reference",
      referenceTo: ["Account", "Opportunity", "Case"],
      relationshipName: "What",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "WhoId",
      type: "reference",
      referenceTo: ["Contact", "Lead"],
      relationshipName: "Who",
      nillable: true,
      custom: false,
      createable: true,
    },
    {
      name: "OwnerId",
      type: "reference",
      referenceTo: ["User"],
      relationshipName: "Owner",
      nillable: false,
      custom: false,
      createable: true,
    },
  ],
};

export const USER: SObjectDescribe = {
  name: "User",
  label: "User",
  custom: false,
  queryable: true,
  createable: false,
  fields: [
    { name: "Id", type: "id", nillable: false, custom: false, createable: false },
    { name: "Username", type: "string", nillable: false, custom: false, createable: true },
    {
      name: "ProfileId",
      type: "reference",
      referenceTo: ["Profile"],
      relationshipName: "Profile",
      nillable: false,
      custom: false,
      createable: true,
    },
  ],
};
